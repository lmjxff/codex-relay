const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AuthRateLimiter,createAuthToken,getClientIp,isLocalhostRequest,verifyToken,escapeHtml}=require('../dist/security');

test('generated credentials are long and independently random',()=>{
  const first=createAuthToken(), second=createAuthToken();
  assert(first.length>=43 && second.length>=43 && first!==second);
  assert(verifyToken(first,first));
  assert(!verifyToken(first,second));
  assert(!verifyToken(first,{token:first}));
});

test('direct clients cannot select their rate-limit address with forwarded headers',()=>{
  const request={socket:{remoteAddress:'203.0.113.8'},headers:{'cf-connecting-ip':'203.0.113.9','x-forwarded-for':'203.0.113.10'}};
  assert.equal(getClientIp(request,false),'203.0.113.8');
  assert.equal(getClientIp(request,true),'203.0.113.8');
});

test('only an enabled local tunnel can supply a valid Cloudflare client IP',()=>{
  const request={socket:{remoteAddress:'127.0.0.1'},headers:{'cf-connecting-ip':'2001:db8::1'}};
  assert.equal(getClientIp(request,true),'2001:db8::1');
  assert.equal(getClientIp(request,false),'127.0.0.1');
  request.headers['cf-connecting-ip']='not-an-ip';
  assert.equal(getClientIp(request,true),'127.0.0.1');
});

test('QR local bypass requires a local Host and excludes forwarded or foreign-origin requests',()=>{
  const request={socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost:3210'}};
  assert(isLocalhostRequest(request));
  request.headers.host='untrusted.example.test';
  assert(!isLocalhostRequest(request));
  request.headers.host='localhost:3210';
  request.headers.origin='https://untrusted.example.test';
  assert(!isLocalhostRequest(request));
  delete request.headers.origin;
  request.headers['cf-connecting-ip']='203.0.113.8';
  assert(!isLocalhostRequest(request));
});

test('failed attempts block and expire within a fixed window',()=>{
  let now=0;
  const limiter=new AuthRateLimiter(()=>now,2,100);
  limiter.fail('client');assert(!limiter.isBlocked('client'));
  limiter.fail('client');assert(limiter.isBlocked('client'));
  now=101;assert(!limiter.isBlocked('client'));
  limiter.fail('client');assert(!limiter.isBlocked('client'));
  limiter.clear('client');assert(!limiter.isBlocked('client'));
});

test('HTML interpolation escapes text',()=>assert.equal(escapeHtml('<a "x">&\''),'&lt;a &quot;x&quot;&gt;&amp;&#39;'));
