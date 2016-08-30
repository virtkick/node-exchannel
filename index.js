let Promise = require('bluebird').getNewLibraryCopy();
let uuid = require('node-uuid');
let EventEmitter = require('events').EventEmitter;
require('promise-resolve-deep')(Promise);

class RemoteError extends Error {
  constructor(message, extra) {
    super(message, extra);
    Error.captureStackTrace(this, this.constructor.name);
    this.name = this.constructor.name;
    this.message = message;
    this.extra = extra;
  }
}

function newCall(Cls, args) {
  args.unshift(null);
  return new (Function.prototype.bind.apply(Cls, args));
}

function makeRequestHandler(cb) {
  return function requestHandler(data, responseCb) {
    Promise.resolve().then(() => Promise.resolveDeep(cb(data)))
      .nodeify(responseCb);
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

class ExChannel extends EventEmitter {
  constructRealError(originalStack, err) {
    let resolvedError;
    if(! (err instanceof Error) && err.message && err.stack) {
      let errInstance = new RemoteError(err.message);
      errInstance.name = 'Remote::' + err.name;
      let constructedStack = err.stack + '\n' + 'From previous event:\n' + originalStack;
      errInstance.stack = constructedStack;
      if(process.env.EWS_PRINT_REMOTE_REJECTIONS) {
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
  
  

  constructor(messageProvider) {
    super();
    this.scopes = {};
    let requestMap = this.requestMap  = {};
    
    let messageHandler = this.messageHandler = msg => {
      let obj = JSON.parse(msg);
      
      let responseFunction = (error, responseData) => {
        if(error && error instanceof Error) {
          error = {
            message: error.message,
            stack: error.stack,
            name: error.name
          };
        }
        try {
          this.send({
            error: error,
            type: obj.type,
            response: obj.uuid,
            data: responseData
          });
        } catch(err) {
          if(err.message !== 'not opened') {
            throw err;
          }
        }
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
  
  send(obj, cb) {
    if(this.messageProvider.send) {
      this.messageProvider.send(JSON.stringify(obj), cb);
    } else {
      cb(new Error('send is not implemented'));
    }
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
  
  sendEvent(type, data, cb) {
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
    this.send(obj, cb);
  }
  
  sendRequest(type, data, opts, cb) {
    let obj;
    opts = opts || {};
    if(typeof opts === 'function') {
      cb = opts;
      opts = {};
    }
    let requestMap = this.requestMap;
    let responseTimeout = opts.responseTimeout || this.responseTimeout || 10000;
    let originalStack = (new Error().stack).replace(/^Error\n/,'');

    return Promise.resolveDeep(data).then(data => {
      return (new Promise((resolve, reject) => {
        obj = {
          type: type,
          data: data,
          uuid: uuid.v4()
        };

        this.send(obj, error => {
          if(error) return reject(error);
           // sent successfuly, wait for response

          requestMap[obj.uuid] = data => {
            delete requestMap[obj.uuid];
            resolve(data);
          };
          requestMap[obj.uuid].error = error => {
            delete requestMap[obj.uuid];
            this.constructRealError(originalStack, error).then(reject);
          };
        });
      })).timeout(responseTimeout).catch(Promise.TimeoutError, err => {
        delete requestMap[obj.uuid];
        if(this.isClosed()) {
          // never resolve, this shouldn't leak as bluebird has no global state
          return new Promise((resolve, reject) => {});
        }
        throw err;
      })
      .nodeify(cb);
    });
  }
};

ExChannel.RemoteError = RemoteError;
ExChannel.Timeout = Promise.Timeout;

module.exports = ExChannel;