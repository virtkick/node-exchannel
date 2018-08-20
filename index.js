let uuidV4 = function(){
  var a,b;
  for(b=a='';a++<36;b+=a*51&52?(a^15?8^Math.random()*(a^20?16:4):4).toString(16):'-');
  return b;
}

let EventEmitter = require('events').EventEmitter;
require('promise-resolve-deep')(Promise);

export class RemoteError extends Error {
  constructor(message, extra) {
    super(message, extra);
    Error.captureStackTrace(this, this.constructor.name);
    this.name = this.constructor.name;
    this.message = message;
    this.extra = extra;
  }
}

export class TimeoutError extends Error {
  constructor(message) {
    super(message);
    Error.captureStackTrace(this, this.constructor.name);
    this.name = this.constructor.name;
    this.message = message;
  }
};

function makeRequestHandler(cb) {
  return function requestHandler(data, responseCb) {
    Promise.resolve().then(() => Promise.resolveDeep(cb(data)))
      // removing nodeify created a problem with responseCb possibly throwing
      // and then calling responseCb again
      .then(data => {
        try {
          responseCb(null, data)
        } catch(err) {
          console.error('Error inside requestHandler:', err);
        };
      }).catch(responseCb);
  };
}

class ScopedChannel {
  constructor(masterRequestHandler, scopeId) {
    this.scopeId = scopeId;
    this.masterRequestHandler = masterRequestHandler;
  }
  destroy() {
    this.masterRequestHandler.destroyScope(this.scopeId);
  }
  removeAllListeners() {
    this.masterRequestHandler.eventNames().forEach(eventName => {
      if(eventName.indexOf(`event:${this.scopeId}`) === 0 ||
        eventName.indexOf(`request:${this.scopeId}`) === 0) {
          this.masterRequestHandler.removeAllListeners(eventName);
        }
    });
  }
}

['onRequest', 'onceRequest', 'onEvent', 'onceEvent', 'offEvent',
'offRequest', 'sendEvent', 'sendRequest'].forEach(methodName => {
  ScopedChannel.prototype[methodName] = function(name, ...args) {
    return this.masterRequestHandler[methodName].call(this.masterRequestHandler, `${this.scopeId}:${name}`, ...args);
  }
});

export class ExChannel extends EventEmitter {
  constructRealError(originalStack, err) {
    let resolvedError;
    if(err.message && err.stack) {
      let errInstance = new RemoteError(err.message);
      errInstance.name = 'Remote::' + err.name;
      let constructedStack = err.stack + '\n' + 'From previous event:\n' + originalStack;
      errInstance.stack = constructedStack;
      if(this.options.printRemoteRejections) {
        console.error(errInstance.stack);
      }
      resolvedError = errInstance;
    } else {
      resolvedError = err;
    }
    if(this.remoteErrorHook) {
      resolvedError = this.remoteErrorHook(resolvedError);
    }
    return Promise.resolve(resolvedError);
  }

  isClosed() {
    if(typeof this.messageProvider.isClosed === 'function') {
      return this.messageProvider.isClosed();
    }

    return false; // needs to re-implemented by children
  }

  setRemoteErrorHook(hook) {
    this.remoteErrorHook = hook;
  }

  scope(scopeId) {
    this.scopes[scopeId] = this.scopes[scopeId] || new ScopedChannel(this, scopeId);
    return this.scopes[scopeId];
  }

  destroyScope(scopeId) {
    let scope = this.scopes[scopeId];
    if(scope) {
      scope.removeAllListeners();
    }
    delete this.scopes[scopeId];
  }

  constructor(messageProvider, {sendRawObjects = false, printRemoteRejections = process.env.EWS_PRINT_REMOTE_REJECTIONS} = {}) {
    super();
    this.options = { sendRawObjects, printRemoteRejections };
    this.scopes = {};
    let requestMap = this.requestMap  = {};

    let messageHandler = this.messageHandler = msg => {
      const obj = this.options.sendRawObjects ?  msg : JSON.parse(msg);
      let responseFunction = (error, responseData) => {
        if(error && error instanceof Error) {
          error = {
            message: error.message,
            stack: error.stack,
            name: error.name
          };
        }
        return this.send({
          error: error,
          type: obj.type,
          response: obj.uuid,
          data: responseData
        }).catch(err => {
          this.emit('messageError', err, msg);
          if(err.message !== 'not opened') {
            throw err;
          }
        });
      };

      try {
        try {
          this.emit('message', obj);
        } catch(err) {
          console.error(err.stack || err);
          this.emit('messageError', err, msg);
        }
        if(obj.type) {
          if(obj.uuid) {
            if(!this.listenerCount('request:'+obj.type)) {
              responseFunction(new Error('No handler for request: ' + obj.type));
            } else {
              this.emit('request:'+obj.type, obj.data, responseFunction);
              this.emit('request', obj.type, obj.data, responseFunction);
            }
          } else if(obj.response) {
            if(requestMap[obj.response]) {
              if(obj.error) {
                requestMap[obj.response].error(obj.error);
              }
              else {
                requestMap[obj.response](obj.data);
              }
            }
            else {
              console.error('Got response without a request', obj.response);
            }
          } else {
            this.emit('event', obj.type, obj.data);
            this.emit('event:'+obj.type, obj.data);
          }
        }
      } catch(err) {
        console.error(err.stack || err);
        this.emit('messageError', err, msg);
      }
    };

    this.messageProvider = messageProvider;
    if(messageProvider.on) {
      messageProvider.on('message', messageHandler);
    } else {
      messageProvider.onMessage = messageHandler;
    }
  }

  onRequest(name, cb) {
    this.on('request:'+name, makeRequestHandler(cb));
  }

  onceRequest(name, cb) {
    this.once('request:'+name, makeRequestHandler(cb));
  }

  onEvent(name, cb) {
    this.on('event:'+name, cb);
  }

  onceEvent(name, cb) {
    this.once('event:'+name, cb);
  }

  offEvent(name, cb) {
    if(cb)
      this.removeListener('event:' + name, cb);
    else
      this.removeAllListeners('event:' + name);
  }

  offRequest(name, cb) {
    if(cb)
      this.removeListener('request:' + name, cb);
    else
      this.removeAllListeners('request:' + name);
  }

  send(obj) {
    return new Promise((resolve, reject) => {
      if(this.messageProvider.send) {
        const payload = this.options.sendRawObjects ?  obj : JSON.stringify(obj);
        return this.messageProvider.send(payload, err => {
          err ? reject(err) : resolve();
        });
      }
      throw new Error('send is not implemented');
    });
  }

  close() {
    if(this.messageProvider.close) {
      this.messageProvider.close();
    } else {
      throw new Error('close is not implemented');
    }
  }

  setResponseTimeout(timeout) {
    this.responseTimeout = parseInt(timeout);
  }

  sendEvent(type, data) {
    if(data && data instanceof Error) {
      data = {
        message: data.message,
        stack: data.stack,
        name: data.name
      };
    }

    let obj = {
      type: type,
      data: data
    };
    return this.send(obj);
  }

  sendRequest(type, data, opts) {
    let obj;
    opts = opts || {};
    if(typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    let requestMap = this.requestMap;
    let responseTimeout = opts.responseTimeout || this.responseTimeout || 10000;
    let originalStack = (new Error().stack || '').replace(/^Error\n/,'');

    return Promise.resolveDeep(data).then(data => {
      return (new Promise((resolve, reject) => {
        obj = {
          type: type,
          data: data,
          uuid: uuidV4()
        };

        const timer = setTimeout(() => {
          reject(new TimeoutError('operation timed out'));
        }, responseTimeout);

        this.send(obj).then(() => {
          requestMap[obj.uuid] = data => {
            clearTimeout(timer);
            delete requestMap[obj.uuid];
            resolve(data);
          };
          requestMap[obj.uuid].error = error => {
            clearTimeout(timer);
            delete requestMap[obj.uuid];
            this.constructRealError(originalStack, error).then(reject);
          };
        });
      })).catch(err => {
        if (!(err instanceof TimeoutError)) {
          throw err;
        }
        delete requestMap[obj.uuid];
        if(this.isClosed()) {
          // never resolve, this shouldn't leak as bluebird has no global state
          return new Promise(() => {});
        }
        throw err;
      });
    });
  }
};

export default ExChannel;
