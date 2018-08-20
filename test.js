let { ExChannel, RemoteError, TimeoutError }  = require('./')
let { EventEmitter } = require('events');
let Promise = require('bluebird');
require('should');
let assert = require('assert');
const { expect } = require('chai');

class FakeWS extends EventEmitter {
  constructor() {
    super();
  }
  
  connect(other) {
    this.receiver = other;
  }
  
  close() {
    this._isClosed = true;
    this.receiver._isClosed = true;
  }
  
  send(obj, cb) {
    setTimeout(() => {
      this.receiver.emit('message', obj)
      if(cb) cb();
    }, 2);
  }
}

if(0) describe('ExChannel', function() {
  let emitter, requestHandler;
  before(() => {
    emitter = new EventEmitter();

    emitter.send = function(obj, cb) {
      emitter.emit('message', obj);
      if (cb) cb();
    };
    requestHandler = new ExChannel(emitter);
  })

  it('should emit event', endTest => {
    requestHandler.onEvent('test', () => {
      endTest();
    })
    requestHandler.sendEvent('test', 'foo');
  });


  it('should emit scoped event', endTest => {
    let scoped = requestHandler.scope('foobar');

    scoped.onEvent('test', () => {
      endTest();
    })
    requestHandler.sendEvent('foobar:test', 'foo');
  });

  it('should not emit scoped event', endTest => {
    let scoped = requestHandler.scope('foobar');

    scoped.onEvent('test', () => {
      endTest();
    })
    scoped.removeAllListeners();
    scoped.onEvent('test2', data => {
      data.should.equal('foo');
      endTest();
    })
    scoped.sendEvent('test2', 'foo');
  });

  it('should handle requests', endTest => {
    let scoped = requestHandler.scope('foobar');
    scoped.onRequest('test', () => {
      return 'bar';
    });
    scoped.sendRequest('test').then(data => {
      data.should.equal('bar');
      endTest();
    })
  });
});

describe('ExChannel - client/server', function() {
  let ws, wsServer;
  beforeEach(() => {
    let wsSocket = new FakeWS();
    let wsServerSocket = new FakeWS();
    wsSocket.connect(wsServerSocket);
    wsServerSocket.connect(wsSocket);
    ws = new ExChannel(wsSocket);
    ws.close = function() {
      wsSocket.close();
    };
    ws.isClosed = function() {
      return wsSocket._isClosed;
    }
    wsServer = new ExChannel(wsServerSocket);
    wsServer.close = function() {
      wsServerSocket.close();
    };
    wsServer.isClosed = function() {
      return wsServerSocket._isClosed;
    };
  });

  it('should work with casual web socket usage', endTest => {
    ws.send('test');
    ws.on('message', function(msg) {
      msg.should.equal('test-reply');
      endTest();
    });

    wsServer.on('message', function(msg) {
      wsServer.send('test-reply');
    });
  });

  it('should send JSON requests through basic API', endTest => {
    ws.sendRequest('test1', {code: 42}).then(res => {
      res.should.equal('foo');

      ws.sendRequest('test2', {code: 43}).then(function(res) {
        res.should.equal('foo2');
        endTest();
      });
    });

    wsServer.on('request:test1', function(data, responseCb) {
      data.code.should.equal(42);
      responseCb(null, 'foo');
    });
    wsServer.on('request:test2', function(data, responseCb) {
      data.code.should.equal(43);
      responseCb(null, 'foo2');
    });
  });

  it('should send JSON requests through promise request handlers',
    endTest => {
    ws.sendRequest('test1', {code: 42}).then(res => {
      res.should.equal('foo');

      ws.sendRequest('test2', {code: 43}).then(res => {
        res.should.equal('foo2');
        endTest();
      });
    });

    wsServer.onRequest('test1', function(data) {
      return 'foo';
    });
    wsServer.onRequest('test2', function(data) {
      return (new Promise(function(resolve, reject) {
        setTimeout(function() {
          resolve('foo2');
        }, 10);
      }));
    });
  });

  it('should send JSON requests through promise request handlers with nested promises',
    () => {
    wsServer.onRequest('test1', function(data) {
      assert.deepEqual(data, {code: 42});
      return Promise.resolve({
        foo: [Promise.resolve('bar'), 'foo']
      });
    });

    return ws.sendRequest('test1', {code: Promise.resolve(42)}).then(res => {
      assert.deepEqual(res, {
        foo: ['bar', 'foo']
      })
    });
  });
  
  it('should send an error if request is not handled', () => {
    let errorHandled = false;
    return ws.sendRequest('test1', {code: 42}).catch(err => {
      if(err.message.match(/No handler for request: test1/)) {
        errorHandled = true;
        return;
      } else {
        throw err;
      }
    }).then(() => {
      expect(errorHandled).to.be.true;
    });
  });

  it('should send exceptions through promise handlers', () => {
    wsServer.onRequest('test', function(data) {
      throw "foo";
    });
    let errorHandled = false;
    return ws.sendRequest('test', {code: 42}).catch(err => {
      errorHandled = true;
      err.should.equal("foo");
    }).then(() => {
      expect(errorHandled).to.be.true;
    });
  });
  
  it('should send real exceptions through promise handlers', () => {
    let errorHandled = false;
    wsServer.onRequest('test', function(data) {
      throw new Error('foo');
    });
    return ws.sendRequest('test', {code: 42}).catch(err => {
      errorHandled = true;
      err.name.should.equal('Remote::Error');
      err.message.should.equal("foo");
    }).then(() => {
      expect(errorHandled).to.be.true;
    });
  });
  
  
  it('should send real exceptions through promise handlers with custom exception hook', () => {
    wsServer.setRemoteErrorHook(err => {
      err.name = 'FooBar';
      return Promise.resolve(err).delay(1);
    });

    ws.onRequest('test', function(data) {
      throw new Error('foo foo foo');
    });

    let errorHandled = false;
    return wsServer.sendRequest('test', {code: 42}).catch(err => {
      errorHandled = true;
      err.name.should.equal('FooBar');
      err.should.be.instanceof(RemoteError);
      err.message.should.equal("foo foo foo");
    }).then(() => {
      expect(errorHandled).to.be.true;
    });
  });

  it('should not send Timeout after disconnected from server', endTest => {
    ws.setResponseTimeout(20);

    let timeout = setTimeout(() => {
      endTest();
    }, 30);

    const cleanup = () => clearTimeout(timeout);

    setTimeout(() => {
      wsServer.close();
    }, 10);
    wsServer.onRequest('test', function(data) {
      return new Promise((resolve, reject) => {});
    });
    ws.sendRequest('test', {code: 42}).then(cleanup).catch(endTest);
  });

  it('should not send Timeout after disconnected from client', endTest => {
    ws.setResponseTimeout(10);

    let timeout = setTimeout(() => {
      endTest();
    }, 15);

    const cleanup = () => clearTimeout(timeout);

    ws.sendRequest('test', {code: 42}).then(cleanup).catch(endTest);
    setTimeout(() => {
      ws.close();
    }, 5);
    wsServer.onRequest('test', function(data) {
      return new Promise((resolve, reject) => {});
    });
  });
      
  it('should send Error exceptions through promise handlers', () => {
    let errorHandled = false;

    wsServer.onRequest('test', function(data) {
      function remoteFunc() {
        throw new Error('error with stacktrace');
      }
      return Promise.resolve().then(remoteFunc);
    });
    return ws.sendRequest('test', {code: 42})
    .catch(function(err) {
      if(!(err instanceof RemoteError)) {
        throw err;
      }
      err.should.be.an.instanceOf(Error);
      err.message.should.equal('error with stacktrace');
      return Promise.resolve().then(function() {
        throw err;
      });
    }).catch(function(err) {
      if(!(err instanceof RemoteError)) {
        throw err;
      }
      errorHandled = true;
      err.stack.should.match(/remoteFunc/);
    }).then(() => {
      expect(errorHandled).to.be.true;
    });
  });

  it('should handle timeout errors', endTest => {
    var gotTimeout = false;

    wsServer.onRequest('test1', function(data) {
      return Promise.delay(20).then(function() {
        if(gotTimeout) {
          endTest();
        } else {
          endTest(new Error('Expected to get timeout'));
        }
        return 'foo';
      });
    });

    ws.sendRequest('test1', {code: 42}, {responseTimeout: 10})
    .then(function(res) {
      res.should.equal('foo');
    }).catch(function(err) {
      if (!(err instanceof TimeoutError)) {
        throw err;
      }
      gotTimeout = true;
      err.message.should.equal('operation timed out');
    });
  });

  it('should send events', endTest => {
    ws.sendEvent('test', {
      code: 'foo'
    });

    wsServer.onEvent('test', function(data) {
      data.code.should.equal('foo');
      endTest();
    });
  });

  it('should not send events when removed', endTest => {
    ws.sendEvent('test', {
      code: 'foo'
    });

    wsServer.onEvent('test', function(data) {
      assert(false, 'Should not happen');
    });

    wsServer.offEvent('test');
    setTimeout(function() {
      endTest();
    }, 10);
  });
      
      
  it('should handle errors inside message handler', endTest => {
    ws.sendEvent('test');

    var tmp = console.error;
    console.error = function(msg) {};
    wsServer.on('message', function(msg) {
      throw new Error('test error');
    });

    wsServer.onEvent('test', function() {
      console.error = tmp;
      endTest();
    });
  });
  
});
