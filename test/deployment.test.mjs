/** @file Single-attempt WireGuard transport and guaranteed cleanup without contacting a server. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { deploymentInputs, verifyDeploymentResponse, connectAndDeploy } from '../src/deploy.mjs';
const spec = { service:'app',path:'/deploy/app' };
const environment = { DEPLOY_HOST:'10.10.0.1',DEPLOY_WG_ADDRESS:'10.10.0.2',DEPLOY_WG_ENDPOINT:'vpn.example.invalid:51820',
  DEPLOY_WG_PRIVATE_KEY:'a'.repeat(43)+'=',DEPLOY_WG_PUBLIC_KEY:'b'.repeat(43)+'=',DEPLOY_TOKEN:'c'.repeat(43),DEPLOY_URL:'https://app.example.invalid/deploy/app' };
const healthy = JSON.stringify({ service:'app',status:'succeeded',healthy:true })+'\n200';

test('only the configured HTTPS service and expected peer are accepted', () => {
  assert.equal(deploymentInputs(spec,environment).url.hostname,'app.example.invalid');
  for (const changed of [ {DEPLOY_HOST:'invalid'}, {DEPLOY_URL:'http://app.example.invalid/deploy/app'}, {DEPLOY_URL:'https://app.example.invalid/deploy/other'},
    {DEPLOY_URL:'https://user:password@app.example.invalid/deploy/app'}, {DEPLOY_WG_ENDPOINT:'bad:99999'}, {DEPLOY_TOKEN:'quote"injection'} ])
    assert.throws(() => deploymentInputs(spec,{...environment,...changed}));
});

test('health acknowledgement must explicitly identify the service and success', () => {
  assert.equal(verifyDeploymentResponse(healthy,'app').healthy,true);
  for (const response of [healthy.replace('200','500'),healthy.replace('succeeded','pending'),healthy.replace('true','false'),healthy.replace('"app"','"other"'),'not-json\n200'])
    assert.throws(() => verifyDeploymentResponse(response,'app'));
});

test('tunnel is configured before a single webhook POST and then removed', () => {
  const calls=[]; let key;
  const result = connectAndDeploy(spec,environment,(binary,args,options) => {
    calls.push([binary,args]);
    if (args.includes('private-key')) { key=args[args.indexOf('private-key')+1]; assert.equal(fs.readFileSync(key,'utf8').trim(),environment.DEPLOY_WG_PRIVATE_KEY); }
    if (binary==='curl') {
      assert.equal(args[args.indexOf('--retry')+1],'0'); assert.ok(!args.join(' ').includes(environment.DEPLOY_TOKEN));
      assert.ok(options.input.includes(environment.DEPLOY_TOKEN)); assert.ok(calls.some(([,a]) => a.includes('route'))); return healthy;
    }
    return '';
  });
  assert.equal(result.healthy,true); assert.equal(calls.filter(([b]) => b==='curl').length,1);
  assert.ok(calls.at(-1)[1].includes('delete')); assert.equal(fs.existsSync(key),false);
});

test('unknown webhook outcome is never retried and still cleans its tunnel and key', () => {
  const calls=[]; let key;
  assert.throws(() => connectAndDeploy(spec,environment,(binary,args) => {
    calls.push([binary,args]); if (args.includes('private-key')) key=args[args.indexOf('private-key')+1];
    if (binary==='curl') throw new Error(environment.DEPLOY_TOKEN); return '';
  }), error => error.message.includes('uncertain') && !error.message.includes(environment.DEPLOY_TOKEN));
  assert.equal(calls.filter(([b])=>b==='curl').length,1); assert.ok(calls.at(-1)[1].includes('delete')); assert.equal(fs.existsSync(key),false);
});

test('failed WireGuard setup never reaches the webhook', () => {
  const calls=[];
  assert.throws(() => connectAndDeploy(spec,environment,(binary,args) => {
    calls.push([binary,args]); if (args.includes('wg')) throw new Error('handshake/configuration failed'); return '';
  }), /uncertain/);
  assert.ok(!calls.some(([b])=>b==='curl')); assert.ok(calls.at(-1)[1].includes('delete'));
});
