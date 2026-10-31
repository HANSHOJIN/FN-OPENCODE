import test from 'node:test'
import assert from 'node:assert/strict'
import { recoverProjectIDs, emptyUpgradeProjectIDs } from '../opencode-fnos/app/gateway/projects.mjs'

test('shared directory and historical npm sessions survive upgrade-created empty defaults', () => {
  const root = '/vol1/@appshare/OpenCode/projects'
  const npm = '/vol1/@apphome/opencode-fnos/.npm'
  const projects = [
    {id:'empty-new', canonical:root+'/默认项目'},
    {id:'global', canonical:'/'},
    {id:'old-npm', canonical:npm},
    {id:'shared', canonical:root},
    {id:'unused-cache', canonical:'/elsewhere/.npm'},
    {id:'custom', canonical:root+'/custom'},
  ]
  const sessions = [{location:{directory:npm}}, {location:{directory:root}}]
  assert.deepEqual(recoverProjectIDs(projects, sessions, root, true), ['shared','old-npm','custom'])
  assert.equal(projects[0].canonical, root+'/默认项目', 'Discovery must not rename or move directories')
  assert.ok(recoverProjectIDs(projects, [...sessions,{location:{directory:root+'/默认项目'}}], root, true).includes('empty-new'), 'Never hide an upgrade folder that already has a session')
  assert.ok(recoverProjectIDs(projects, [], root, false).includes('empty-new'), 'Keep nonempty project directories')
  assert.deepEqual(emptyUpgradeProjectIDs(projects,sessions,root,true),['empty-new'])
  assert.deepEqual(emptyUpgradeProjectIDs(projects,[...sessions,{location:{directory:root+'/默认项目'}}],root,true),[])
  assert.deepEqual(emptyUpgradeProjectIDs(projects,undefined,root,true),[], 'Unavailable history must not retire a project')
  assert.deepEqual(emptyUpgradeProjectIDs(projects,sessions,root,false),[])
})

test('discovery tolerates unavailable history, malformed responses, duplicates and bounded lists', () => {
  assert.deepEqual(recoverProjectIDs(null, [], '/projects'), [])
  assert.deepEqual(recoverProjectIDs([{id:'one',canonical:'/projects'},{id:'one',canonical:'/projects'},null,{}], null, '/projects/'), ['one'])
  assert.equal(recoverProjectIDs(Array.from({length:120}, (_,i)=>({id:String(i),canonical:'/projects/'+i})), [], '/projects').length, 100)
})
