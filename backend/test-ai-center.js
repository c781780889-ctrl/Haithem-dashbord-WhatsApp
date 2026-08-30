'use strict';
const assert=require('assert');
const service=require('./src/api/services/AIAutomationService');
const db=require('./src/database/SystemDB');
(async()=>{
  const oldGet=db.get, oldRun=db.run; let approvalWrites=0;
  db.get=async(sql,args)=>{
    if(sql.includes('INSERT INTO ai_tasks')) return {id:'task-1',user_id:args[0],status:args[6],risk_score:args[8],confidence:args[9],workflow_id:null,agent_id:null};
    return null;
  };
  db.run=async(sql)=>{if(sql.includes('INSERT INTO ai_approvals'))approvalWrites++;return {rowCount:1};};
  try{
    const blocked=await service.createTask('user-1',{name:'critical',risk_score:90,idempotency_key:'critical-1'});
    assert.equal(blocked.status,'blocked'); assert.equal(approvalWrites,0);
    const supervised=await service.createTask('user-1',{name:'review',risk_score:60,confidence:.72,idempotency_key:'review-1'});
    assert.equal(supervised.status,'waiting_approval'); assert.equal(approvalWrites,1);
    assert.equal(service.tools().some(t=>t.name==='database_read'),true);
    assert.equal(service.tools().some(t=>t.name==='workflow_trigger'&&t.risk==='high'),true);
    console.log('ai-center risk/approval tests: ok');
  }finally{db.get=oldGet;db.run=oldRun;}
})().catch(e=>{console.error(e);process.exit(1);});
