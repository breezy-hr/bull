/*eslint-env node */
'use strict';

var redis = require('ioredis');
var Disturbed = require('disturbed');
var util = require('util');
var assert = require('assert');
var url = require('url');
var Job = require('./job');
var scripts = require('./scripts');
var TimerManager = require('./timer-manager');
var _ = require('lodash');
var Promise = require('bluebird');
var semver = require('semver');
var debuglog = require('debuglog')('bull');

/**
  Gets or creates a new Queue with the given name.

  The Queue keeps 6 data structures:
    - wait (list)
    - active (list)
    - delayed (zset)
    - priority (zset)
    - completed (set)
    - failed (set)

        --> priorities      -- >completed
       /                   /
    job -> wait -> active
        |    ^            \
        v    |             -- > failed
        delayed
*/

/**
  Delayed jobs are jobs that cannot be executed until a certain time in
  ms has passed since they were added to the queue.
  The mechanism is simple, a delayedTimestamp variable holds the next
  known timestamp that is on the delayed set (or MAX_TIMEOUT_MS if none).

  When the current job has finalized the variable is checked, if
  no delayed job has to be executed yet a setTimeout is set so that a
  delayed job is processed after timing out.
*/
var MINIMUM_REDIS_VERSION = '2.8.11';
var LOCK_DURATION = 5000; // 5 seconds is the duration of the lock.
var LOCK_RENEW_TIME = LOCK_DURATION / 2; 

// The interval for which to check for stalled jobs.
var STALLED_JOB_CHECK_INTERVAL = 5000; // 5 seconds is the renew time.

// The maximum number of times a job can be recovered from the 'stalled' state
// (moved back to 'wait'), before it is failed.
var MAX_STALLED_JOB_COUNT = 1;

var CLIENT_CLOSE_TIMEOUT_MS = 5000;
var POLLING_INTERVAL = 5000;

var REDLOCK_DRIFT_FACTOR = 0.01;
var REDLOCK_RETRY_COUNT = 0;
var REDLOCK_RETRY_DELAY = 200;

var MAX_TIMEOUT_MS = Math.pow(2, 31) - 1; // 32 bit signed

var Queue = function Queue(name, redisPort, redisHost, redisOptions){
  if(!(this instanceof Queue)){
    return new Queue(name, redisPort, redisHost, redisOptions);
  }

  if(_.isObject(redisPort)) {
    var opts = redisPort;
    var redisOpts = opts.redis || {};
    redisPort = redisOpts.port;
    redisHost = redisOpts.host;
    redisOptions = redisOpts.opts || {};
    redisOptions.db = redisOpts.DB || redisOpts.DB;
  } else if(parseInt(redisPort) == redisPort) {
    redisPort = parseInt(redisPort);
    redisOptions =  redisOptions || {};
  } else if(_.isString(redisPort)) {
    try {
      var redisUrl = url.parse(redisPort);
      assert(_.isObject(redisHost) || _.isUndefined(redisHost),
          'Expected an object as redis option');
      redisOptions =  redisHost || {};
      redisPort = redisUrl.port;
      redisHost = redisUrl.hostname;
      if (redisUrl.auth) {
        redisOptions.password = redisUrl.auth.split(':')[1];
      }
    } catch (e) {
      throw new Error(e.message);
    }
  }

  redisOptions = redisOptions || {};

  function createClient(type) {
    var client;
    if(_.isFunction(redisOptions.createClient)){
      client = redisOptions.createClient(type);
    }else{
      client = new redis(redisPort, redisHost, redisOptions);
    }
    return client;
  }

  redisPort = redisPort || 6379;
  redisHost = redisHost || '127.0.0.1';

  var _this = this;

  this.name = name;
  this.keyPrefix = redisOptions.keyPrefix || 'bull';

  //
  // We cannot use ioredis keyPrefix feature until we
  // stop creating keys dynamically in lua scripts.
  //
  delete redisOptions.keyPrefix;

  //
  // Create queue client (used to add jobs, pause queues, etc);
  //
  this.client = createClient('client');

  getRedisVersion(this.client).then(function(version){
    if(semver.lt(version, MINIMUM_REDIS_VERSION)){
      throw new Error('Redis version needs to be greater than ' + MINIMUM_REDIS_VERSION + '. Current: ' + version);
    }
  }).catch(function(err){
    _this.emit('error', err);
  });

  //
  // Keep track of cluster clients for redlock
  //
  this.clients = [this.client];
  if (redisOptions.clients) {
    this.clients.push.apply(this.clients, redisOptions.clients);
  }
  this.redlock = {
    driftFactor: REDLOCK_DRIFT_FACTOR,
    retryCount: REDLOCK_RETRY_COUNT,
    retryDelay: REDLOCK_RETRY_DELAY
  };
  _.extend(this.redlock, redisOptions.redlock || {});

  //
  // Create blocking client (used to wait for jobs)
  //
  this.bclient = createClient('block');

  //
  // Create event subscriber client (receive messages from other instance of the queue)
  //
  this.eclient = createClient('subscriber');

  this.delayTimer = null;
  this.processing = 0;
  this.retrieving = 0;

  this.LOCK_RENEW_TIME = LOCK_RENEW_TIME;
  this.LOCK_DURATION = LOCK_DURATION;
  this.STALLED_JOB_CHECK_INTERVAL = STALLED_JOB_CHECK_INTERVAL;
  this.MAX_STALLED_JOB_COUNT = MAX_STALLED_JOB_COUNT;

  // bubble up Redis error events
  [this.client, this.bclient, this.eclient].forEach(function (client) {
    client.on('error', _this.emit.bind(_this, 'error'));
  });

  // keeps track of active timers. used by close() to
  // ensure that disconnect() is deferred until all
  // scheduled redis commands have been executed
  this.timers = new TimerManager();

  // emit ready when redis connections ready
  var initializers = [this.client, this.bclient, this.eclient].map(function (client) {
    return new Promise(function(resolve, reject) {
      client.once('ready', resolve);
      client.once('error', reject);
    });
  });

  this._initializing = Promise.all(initializers).then(function(){
    return Promise.join(
      _this.eclient.subscribe(_this.toKey('delayed')),
      _this.eclient.subscribe(_this.toKey('paused'))
    );
  }).then(function(){
    debuglog(name + ' queue ready');
    _this.emit('ready');
  }, function(err){
    console.error('Error initializing queue:', err);
  });

  Disturbed.call(this, _this.client, _this.eclient);

  //
  // Listen distributed queue events
  //
  listenDistEvent('stalled'); //
  listenDistEvent('active'); //
  listenDistEvent('completed'); //
  listenDistEvent('failed'); //
  listenDistEvent('cleaned');
  listenDistEvent('waiting'); //
  listenDistEvent('remove'); //
  listenDistEvent('progress'); //

  function listenDistEvent(eventName){
    var _eventName = eventName + '@' + name;
    _this.on(_eventName, function(){
      var args = Array.prototype.slice.call(arguments);

      if(eventName !== 'cleaned' && eventName !== 'error'){
        args[0] = Job.fromJSON(_this, args[0]);
      }

      args.unshift('global:' + eventName);
      _this.emit.apply(_this, args);
    }, true);
  }

  //
  // Handle delay, pause and resume messages
  //
  var delayedKey = _this.toKey('delayed');
  var pausedKey = _this.toKey('paused');
  this.eclient.on('message', function(channel, message){
    if(channel === delayedKey){
      _this.updateDelayTimer(message);
    }else if(channel === pausedKey){
      _this.emit(message);
    }
  });

  //
  // Init delay timestamp.
  //
  this.delayedTimestamp = Number.MAX_VALUE;
  scripts.updateDelaySet(this, Date.now()).then(function(timestamp){
    if(timestamp){
      _this.updateDelayTimer(timestamp);
    }
  });

  //
  // Create a guardian timer to revive delayTimer if necessary
  // This is necessary when redis connection is unstable, which can cause the pub/sub to fail
  //
  this.guardianTimer = setInterval(function() {
    if(_this.delayedTimestamp < Date.now() || _this.delayedTimestamp - Date.now() > POLLING_INTERVAL){
      scripts.updateDelaySet(_this, Date.now()).then(function(timestamp){
        if(timestamp){
          _this.updateDelayTimer(timestamp);
        }
      }).catch(function(err){
        console.error(err);
      });
    }
  }, POLLING_INTERVAL);

  // Bind these methods to avoid constant rebinding and/or creating closures
  // in processJobs etc.
  this.moveUnlockedJobsToWait = this.moveUnlockedJobsToWait.bind(this);
  this.getNextJob = this.getNextJob.bind(this);
  this.processJobs = this.processJobs.bind(this);
  this.processJob = this.processJob.bind(this);
  this.getJobFromId = Job.fromId.bind(null, this);
};

util.inherits(Queue, Disturbed);

Queue.prototype.isReady = function(){
  var _this = this;
  return this._initializing.then(function(){
    return _this;
  });
}

Queue.prototype.getJobMoveCount = function(){
  return this.bclient.commandQueue.length;
};

Queue.prototype.whenCurrentMoveFinished = function(){
  var currentMove = this.bclient.commandQueue.peekFront()
  return currentMove && currentMove.command.promise || Promise.resolve();
};
/**
 *
 * Emits a distributed event.
 */
Queue.prototype.distEmit = function(){
  var args = Array.prototype.slice.call(arguments);

   // Emit local event
  this.emit.apply(this, args);

  // Emit global event
  args[0] = args[0] + '@' + this.name;
  return Disturbed.prototype.distEmit.apply(this, args);
}

Queue.prototype.on = function(){
  var args = Array.prototype.slice.call(arguments);
  var promise = Disturbed.prototype.on.apply(this, args);
  var _this = this;
  promise.catch(function(err){ _this.emit('error', err); });
  return this;
};

Queue.prototype.once = function(){
  var args = Array.prototype.slice.call(arguments);
  Disturbed.prototype.once.apply(this, args);
  return this;
};

Queue.prototype.disconnect = function(){
  var _this = this;

  function endClients(){
    var timeoutMsg = 'Timed out while waiting for redis clients to close';

    return new Promise(function(resolve) {
      _this.bclient.end(true);
      _this.bclient.stream.once('close', resolve);
    }).timeout(CLIENT_CLOSE_TIMEOUT_MS, timeoutMsg)
    .catch(function(err){
      if(!(err instanceof Promise.TimeoutError)){
        throw err;
      }
    });
  }

  return Promise.join(
    _this.client.quit(),
    _this.eclient.quit()
  ).then(endClients, endClients);
};

Queue.prototype.close = function( doNotWaitJobs ){
  var _this = this;

  if(this.closing){
    return this.closing;
  }


  return this.closing = this._initializing.then(function(){
    clearTimeout(_this.delayTimer);
    clearInterval(_this.guardianTimer);
    clearInterval(_this.moveUnlockedJobsToWaitInterval);
    _this.timers.clearAll();

    return _this.timers.whenIdle().then(function(){
      return _this.pause(true, doNotWaitJobs);
    }).then(function(){
      return _this.disconnect();
    }).then(function(){
      _this.closed = true;
    });
  });
};

/**
  Processes a job from the queue. The callback is called for every job that
  is dequeued.

  @method process
*/
Queue.prototype.process = function(concurrency, handler){
  var _this = this;
  if(typeof concurrency === 'function'){
    handler = concurrency;
    concurrency = 1;
  }

  this.setHandler(handler);

  var runQueueWhenReady = function(){
    _this.bclient.once('ready', function(){
      _this.run(concurrency).catch(function(err){
        console.error(err);
      });
    });
  };

  // attempt to restart the queue when the client throws
  // an error or the connection is dropped by redis
  this.bclient.on('error', runQueueWhenReady);
  this.bclient.on('end', runQueueWhenReady);

  return this.run(concurrency).catch(function(err){
    console.error(err);
    throw err;
  });
};

Queue.prototype.setHandler = function(handler){
  if(this.handler) {
    throw new Error('Cannot define a handler more than once per Queue instance');
  }

  handler = handler.bind(this);

  if(handler.length > 1){
    this.handler = Promise.promisify(handler);
  }else{
    this.handler = Promise.method(handler);
  }
};

/**
interface JobOptions
{
  attempts: number;
}
*/

/**
  Adds a job to the queue.
  @method add
  @param data: {} Custom data to store for this job. Should be JSON serializable.
  @param opts: JobOptions Options for this job.
*/
Queue.prototype.add = function(data, opts){
  return Job.create(this, data, opts);
};

/**
  Returns the number of jobs waiting to be processed.
*/
Queue.prototype.count = function(){
  var multi = this.multi();
  multi.llen(this.toKey('wait'));
  multi.llen(this.toKey('paused'));
  multi.zcard(this.toKey('delayed'));

  return multi.exec().then(function(res){
    return Math.max(res[0][1], res[1][1]) + res[2][1];
  });
};

/**
  Empties the queue.

  Returns a promise that is resolved after the operation has been completed.
  Note that if some other process is adding jobs at the same time as emptying,
  the queues may not be really empty after this method has executed completely.
  Also, if the method does error between emptying the lists and removing all the
  jobs, there will be zombie jobs left in redis.

  TODO: Use EVAL to make this operation fully atomic.
*/
Queue.prototype.empty = function(){
  var _this = this;

  // Get all jobids and empty all lists atomically.
  var multi = this.multi();

  multi.lrange(this.toKey('wait'), 0, -1);
  multi.lrange(this.toKey('paused'), 0, -1);
  multi.del(this.toKey('wait'));
  multi.del(this.toKey('paused'));
  multi.del(this.toKey('meta-paused'));
  multi.del(this.toKey('delayed'));

  return multi.exec().spread(function(waiting, paused){
    waiting = waiting[1];
    paused = paused[1];
    var jobKeys = (paused.concat(waiting)).map(_this.toKey, _this);

    if(jobKeys.length){
      multi = _this.multi();

      multi.del.apply(multi, jobKeys);
      return multi.exec();
    }
  });
};

/**
  Pauses the processing of this queue, locally if true passed, otherwise globally.

  For global pause, we use an atomic RENAME operation on the wait queue. Since
  we have blocking calls with BRPOPLPUSH on the wait queue, as long as the queue
  is renamed to 'paused', no new jobs will be processed (the current ones
  will run until finalized).

  Adding jobs requires a LUA script to check first if the paused list exist
  and in that case it will add it there instead of the wait list.
*/
Queue.prototype.pause = function(isLocal, doNotWaitActive){
  if(isLocal){
    var _this = this;

    if(!this.paused){
      this.paused = new Promise(function(resolve) {
        _this.resumeLocal = function() {
          resolve();
          _this.paused = null; // Allow pause to be checked externally for paused state.
        };
      });
    }

    return !doNotWaitActive && this.whenCurrentJobsFinished();
  }else{
    return pauseResumeGlobal(this, true);
  }
};

Queue.prototype.resume = function(isLocal /* Optional */){
  if(isLocal){
    if(this.resumeLocal){
      this.resumeLocal();
    }
    return Promise.resolve();
  }else{
    return pauseResumeGlobal(this, false);
  }
};

//
// TODO: move to scripts module.
//
function pauseResumeGlobal(queue, pause){
  var src = 'wait', dst = 'paused';
  if(!pause){
    src = 'paused';
    dst = 'wait';
  }

  var script = [
    'if redis.call("EXISTS", KEYS[1]) == 1 then',
    ' redis.call("RENAME", KEYS[1], KEYS[2])',
    'end',
    'if ARGV[1] == "paused" then',
    ' redis.call("SET", KEYS[3], 1)',
    'else',
    ' redis.call("DEL", KEYS[3])',
    'end',
    'redis.call("PUBLISH", KEYS[4], ARGV[1])'
  ].join('\n');

  var keys = _.map([src, dst, 'meta-paused', 'paused'], function(name){
    return queue.toKey(name);
  });

  return queue.client.eval(script, keys.length, keys[0], keys[1], keys[2], keys[3], pause ? 'paused' : 'resumed');
}

Queue.prototype.run = function(concurrency){
  var promises = [];
  var _this = this;

  return this.moveUnlockedJobsToWait().then(function(){

    while(concurrency--){
      promises.push(new Promise(_this.processJobs));
    }

    _this.startMoveUnlockedJobsToWait();

    return Promise.all(promises);
  });
};

// ---------------------------------------------------------------------
// Private methods
// ---------------------------------------------------------------------

/**
  This function updates the delay timer, which is a timer that timeouts
  at the next known delayed job.
*/
Queue.prototype.updateDelayTimer = function(newDelayedTimestamp){
  var _this = this;

  if(newDelayedTimestamp < _this.delayedTimestamp && newDelayedTimestamp < (MAX_TIMEOUT_MS + Date.now())){
    clearTimeout(this.delayTimer);
    this.delayedTimestamp = newDelayedTimestamp;

    var nextDelayedJob = newDelayedTimestamp - Date.now();
    nextDelayedJob = nextDelayedJob < 0 ? 0 : nextDelayedJob;

    this.delayTimer = setTimeout(function(){
      scripts.updateDelaySet(_this, _this.delayedTimestamp).then(function(nextTimestamp){
        if(nextTimestamp){
          nextTimestamp = nextTimestamp < Date.now() ? Date.now() : nextTimestamp;
        }else{
          nextTimestamp = Number.MAX_VALUE;
        }
        _this.updateDelayTimer(nextTimestamp);
      }).catch(function(err){ 
        console.error('Error updating the delay timer', err);
      });
      _this.delayedTimestamp = Number.MAX_VALUE;
    }, nextDelayedJob);
  }
};

/**
 * Process jobs that have been added to the active list but are not being
 * processed properly. This can happen due to a process crash in the middle
 * of processing a job, leaving it in 'active' but without a job lock.
*/
Queue.prototype.moveUnlockedJobsToWait = function(){
  var _this = this;

  return scripts.moveUnlockedJobsToWait(this).then(function(responses){
    var handleFailedJobs = responses[0].map(function(jobId){
      return _this.getJobFromId(jobId).then(function(job){
        _this.distEmit('failed', job, new Error('job stalled more than allowable limit'));
        return null;
      });
    });
    var handleStalledJobs = responses[1].map(function(jobId){
      return _this.getJobFromId(jobId).then(function(job){
        _this.distEmit('stalled', job);
        return null;
      });
    });
    return Promise.all(handleFailedJobs.concat(handleStalledJobs));
  }).catch(function(err){
    console.error('Failed to handle unlocked job in active:', err);
  });
};

Queue.prototype.startMoveUnlockedJobsToWait = function() {
  if (this.STALLED_JOB_CHECK_INTERVAL > 0){
    clearInterval(this.moveUnlockedJobsToWaitInterval);
    this.moveUnlockedJobsToWaitInterval =
      setInterval(this.moveUnlockedJobsToWait, this.STALLED_JOB_CHECK_INTERVAL);
  }
};

Queue.prototype.processJobs = function(resolve, reject){
  var _this = this;
  var processJobs = this.processJobs.bind(this, resolve, reject);

  if(!this.closing){
    process.nextTick(function(){
      (_this.paused || Promise.resolve())
        .then(_this.getNextJob)
        .then(_this.processJob)
        .then(processJobs, function(err){
          console.error('Error processing job:', err);
          processJobs();
        }).catch(reject);
    });
  }else{
    resolve(this.closing);
  }
};

Queue.prototype.processJob = function(job){
  var _this = this;
  var lockRenewId;
  var timmerStopped = false;

  if(!job){
    return Promise.resolve();
  }

  //
  // TODO:
  // There are two cases to take into consideration regarding locks.
  // 1) The lock renewer fails to renew a lock, this should make this job
  // unable to complete, since some other worker is also working on it.
  // 2) The lock renewer is called more seldom than the check for stalled
  // jobs, so we can assume the job has been stalled and is already being processed
  // by another worker. See #308
  //
  var renew = false;
  var lockRenewer = function(){
    return job.takeLock(renew, true).then(function(lock){
      if(lock && !timmerStopped){
        renew = true;
        lockRenewId = _this.timers.set('lockRenewer', _this.LOCK_RENEW_TIME, lockRenewer);
      }
      // TODO: if we failed to re-acquire the lock while trying to renew, should we let the job
      // handler know and cancel the timer?
      return lock;
    }, function(err){
      console.error('Error renewing lock ' + err);
    });
  };

  var timeoutMs = job.opts.timeout;

  function stopTimer(){
    timmerStopped = true;
    _this.timers.clear(lockRenewId);
    return Promise.resolve();
  }

  function handleCompleted(data){
    try{
      JSON.stringify(data);
    }catch(err){
      return handleFailed(err);
    }
    // This substraction is duplicate in handleCompleted and handleFailed because it have to be made before throwing any
    // event completed or failed in order to allow pause() to work correctly without getting stuck.
    _this.processing--;

    stopTimer();

    if(_this.closed){
      return;
    }

    return job.moveToCompleted(data).then(function(){
      return _this.distEmit('completed', job, data);
    });
  }

  function handleFailed(err){
    var error = err.cause || err; //Handle explicit rejection

    // TODO: Should moveToFailed ensure the lock atomically in one of its Lua scripts?
    // See https://github.com/OptimalBits/bull/pull/415#issuecomment-269744735
    job.takeLock(true /* renwew */, false /* ensureActive */).then( function(lock) {
      return stopTimer()
        .then(job.moveToFailed(err))
        .then(job.releaseLock.bind(job))
        .then(function(){
          return _this.distEmit('failed', job, error);
        });
    }, function(err){
      console.error('failed to re-obtain lock before moving to failed, bailing: ', err);
      stopTimer();
    });
    _this.processing--;
  }

  return lockRenewer().then(function(locked){
    if(locked){
      var jobPromise = _this.handler(job);

      if(timeoutMs){
        jobPromise = jobPromise.timeout(timeoutMs);
      }

      _this.distEmit('active', job, jobPromise);

      return jobPromise
        .then(handleCompleted, handleFailed);
    }
  });
};

/**
  Returns a promise that resolves to the next job in queue.
*/
Queue.prototype.getNextJob = function(opts){
  var _this = this;
  if(!this.closing){
    this.retrieving++;
    return this.moveJob('wait', 'active', opts)
      .then(this.getJobFromId)
      .tap(function(job) {
        _this.retrieving--;
        if (job) {
          _this.processing++;
        } else {
          _this.emit('no-job-retrieved');
        }
      })
      .catch(function(err) {
        _this.retrieving--;
        _this.emit('no-job-retrieved');
        throw err;
      });
  }else{
    return Promise.reject();
  }
};

Queue.prototype.multi = function(){
  return this.client.multi();
};

/**
  Atomically moves a job from one list to another.

  @method moveJob
*/
Queue.prototype.moveJob = function(src, dst, opts) {
  var args = arguments;
  var _this = this;
  var move;
  if(opts && opts.block === false){
    if(!this.closing){
      move = this.bclient.rpoplpush(this.toKey(src), this.toKey(dst));
    }else{
      move = Promise.reject();
    }
  } else if (this.closing || this.paused) {
    move = Promise.resolve();
  } else if (this.getJobMoveCount()) {
    move = this.whenCurrentMoveFinished().then(function() {
      return _this.moveJob.apply(_this, args);
    });
  }else{
    move = this.bclient.brpoplpush(
      this.toKey(src),
      this.toKey(dst),
      Math.floor(this.LOCK_RENEW_TIME / 1000));
  }

  return move.then(function(jobId){
    //
    // Unfortunatelly this cannot be performed atomically, which will lead to a
    // slight hazard for priority queues (will only affect its order).
    //
    if(jobId){
      return _this.client.zrem(_this.toKey('priority'), jobId).then(function(){
        return jobId;
      });
    }
  }, function(err){
    if(!_this.closing){
      throw err;
    }
  });
};

Queue.prototype.getJob = function(jobId){
  return Job.fromId(this, jobId);
};

// Job counts by type
// Queue#getJobCountByTypes('completed') => completed count
// Queue#getJobCountByTypes('completed,failed') => completed + failed count
// Queue#getJobCountByTypes('completed', 'failed') => completed + failed count
// Queue#getJobCountByTypes('completed,waiting', 'failed') => completed + waiting + failed count
Queue.prototype.getJobCountByTypes = function() {
  var _this = this;
  var args = _.compact(Array.prototype.slice.call(arguments));
  var types = _.compact(args.join(',').replace(/ /g, '').split(','));

  var multi = this.multi();

  _.each(types, function(type) {
    var key = _this.toKey(type);
    switch(type) {
      case 'completed':
      case 'failed':
        multi.scard(key);
        break;
      case 'delayed':
        multi.zcard(key);
        break;
      case 'active':
      case 'wait':
      case 'paused':
        multi.llen(key);
        break;
    }
  });

  return multi.exec().then(function(res){
    return res.map(function(v) {
      return v[1]
    }).reduce(function(a, b) {
      return a + b
    });	     
  }) || 0;
};

/**
 * Returns all the job counts for every list/set in the queue.
 * 
 */
Queue.prototype.getJobCounts = function(){
  var types = ['wait', 'active', 'completed', 'failed', 'delayed'];
  var counts = {};
  return this.client.multi()
    .llen(this.toKey('wait'))
    .llen(this.toKey('active'))
    .scard(this.toKey('completed'))
    .scard(this.toKey('failed'))
    .zcard(this.toKey('delayed'))
    .exec().then(function(result){
      result.forEach(function(res, index){
        counts[types[index]] = res[1] || 0;
      });
      return counts;
    });
};

Queue.prototype.getCompletedCount = function() {
  return this.client.scard(this.toKey('completed'));
};

Queue.prototype.getFailedCount = function() {
  return this.client.scard(this.toKey('failed'));
};

Queue.prototype.getDelayedCount = function() {
  return this.client.zcard(this.toKey('delayed'));
};

Queue.prototype.getActiveCount = function() {
  return this.client.llen(this.toKey('active'));
};

Queue.prototype.getWaitingCount = function() {
  return this.client.llen(this.toKey('wait'));
};

Queue.prototype.getPausedCount = function() {
  return this.client.llen(this.toKey('paused'));
};

Queue.prototype.getWaiting = function(/*start, end*/){
  return Promise.join(
    this.getJobs('wait', 'LIST'),
    this.getJobs('paused', 'LIST')).spread(function(waiting, paused){
      return _.concat(waiting, paused);
    });
};

Queue.prototype.getActive = function(/*start, end*/){
  return this.getJobs('active', 'LIST');
};

Queue.prototype.getDelayed = function(/*start, end*/){
  return this.getJobs('delayed', 'ZSET');
};

Queue.prototype.getCompleted = function(){
  return this.getJobs('completed', 'SET');
};

Queue.prototype.getFailed = function(){
  return this.getJobs('failed', 'SET');
};

Queue.prototype.getJobs = function(queueType, type, start, end){
  var _this = this;
  var key = this.toKey(queueType);
  var jobs;

  start = _.isUndefined(start) ? 0 : start;
  end = _.isUndefined(end) ? -1 : end;

  switch(type){
    case 'LIST':
      jobs = this.client.lrange(key, start, end);
      break;
    case 'SET':
      jobs = this.client.smembers(key).then(function(jobIds) {
        // Can't set a range for smembers. So do the slice programatically instead.
        // Note that redis ranges are inclusive, so handling for javascript accordingly
        if (end === -1) {
          return jobIds.slice(start);
        }

        return jobIds.slice(start, end + 1);
      });
      break;
    case 'ZSET':
      jobs = this.client.zrange(key, start, end);
      break;
  }

  return jobs.then(function(jobIds){
    var jobsFromId = jobIds.map(_this.getJobFromId);
    return Promise.all(jobsFromId);
  });
};

Queue.prototype.retryJob = function(job) {
  return job.retry();
};

Queue.prototype.toKey = function(queueType){
  return [this.keyPrefix, this.name, queueType].join(':');
};

/*@function startCleaner
 *
 * Cleans jobs from a queue. Similar to remove but keeps jobs within a certian
 * grace period.
 *
 * @param {int} grace - The grace period
 * @param {string} [type=completed] - The type of job to clean. Possible values
 * @param {int} The max number of jobs to clean
 * are completed, waiting, active, delayed, failed. Defaults to completed.
 */
Queue.prototype.clean = function (grace, type, limit) {
  var _this = this;

  return new Promise(function (resolve, reject) {
    if(grace === undefined || grace === null) {
      return reject(new Error('You must define a grace period.'));
    }

    if(!type) {
      type = 'completed';
    }

    if(_.indexOf([
      'completed',
      'wait',
      'active',
      'delayed',
      'failed'], type) === -1){
      return reject(new Error('Cannot clean unkown queue type'));
    }

    return scripts.cleanJobsInSet(_this, type, Date.now() - grace, limit).then(function (jobs) {
      _this.distEmit('cleaned', jobs, type);
      resolve(jobs);
      return null;
    }).catch(function (err) {
      _this.emit('error', err);
      reject(err);
    });
  });
};

/**
 * Returns a promise that resolves when active jobs are cleared
 *
 * @returns {Promise}
 */
Queue.prototype.whenCurrentJobsFinished = function(){
  var _this = this;
  var resolver;
  var count = this.processing + this.retrieving;
  return new Promise(function(resolve) {
    if(count === 0){
      resolve();
    }else{
      resolver = _.after(count, function(){
        _this.removeListener('stalled', resolver);
        _this.removeListener('completed', resolver);
        _this.removeListener('failed', resolver);
        _this.removeListener('no-job-retrieved', resolver);
        clearInterval(_this.moveUnlockedJobsToWaitInterval);
        resolve();
      });

      _this.on('stalled', resolver);
      _this.on('completed', resolver);
      _this.on('failed', resolver);
      _this.on('no-job-retrieved', resolver);

      _this.startMoveUnlockedJobsToWait();
    }
  });
};

//
// Private local functions
//
var getRedisVersion = function getRedisVersion(client){
  return client.info().then(function(doc){
    var prefix = 'redis_version:';
    var lines = doc.split('\r\n');
    for(var i = 0; i < lines.length; i++){
      if(lines[i].indexOf(prefix) === 0){
        return lines[i].substr(prefix.length);
      }
    }
  });
};

module.exports = Queue;
