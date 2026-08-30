'use strict';
const Service=require('../services/AIAutomationService');
class AIAutomationController{
 uid(req){return Service.getUserId(req);}
 async dashboard(req,res){try{res.json({success:true,...await Service.dashboard(this.uid(req))});}catch(e){res.status(500).json({success:false,error:e.message});}}
 async tools(req,res){res.json({success:true,tools:Service.tools()});}
 async agents(req,res){try{res.json({success:true,agents:await Service.agents(this.uid(req))});}catch(e){res.status(500).json({success:false,error:e.message});}}
 async createAgent(req,res){try{res.status(201).json({success:true,agent:await Service.createAgent(this.uid(req),req.body)});}catch(e){res.status(400).json({success:false,error:e.message});}}
 async toggleAgent(req,res){try{res.json({success:true,agent:await Service.toggleAgent(this.uid(req),req.params.id,req.body.status)});}catch(e){res.status(400).json({success:false,error:e.message});}}
 async workflows(req,res){try{res.json({success:true,workflows:await Service.workflows(this.uid(req))});}catch(e){res.status(500).json({success:false,error:e.message});}}
 async createWorkflow(req,res){try{res.status(201).json({success:true,workflow:await Service.createWorkflow(this.uid(req),req.body)});}catch(e){res.status(400).json({success:false,error:e.message});}}
 async updateWorkflow(req,res){try{res.json({success:true,workflow:await Service.updateWorkflow(this.uid(req),req.params.id,req.body)});}catch(e){res.status(400).json({success:false,error:e.message});}}
 async toggleWorkflow(req,res){try{res.json({success:true,workflow:await Service.toggleWorkflow(this.uid(req),req.params.id,req.body.status)});}catch(e){res.status(400).json({success:false,error:e.message});}}
 async tasks(req,res){try{res.json({success:true,tasks:await Service.tasks(this.uid(req),req.query.limit)});}catch(e){res.status(500).json({success:false,error:e.message});}}
 async createTask(req,res){try{res.status(202).json({success:true,task:await Service.createTask(this.uid(req),req.body)});}catch(e){res.status(400).json({success:false,error:e.message});}}
 async controlTask(req,res){try{res.json({success:true,task:await Service.controlTask(this.uid(req),req.params.id,req.body.action)});}catch(e){res.status(400).json({success:false,error:e.message});}}
 async approvals(req,res){try{res.json({success:true,approvals:await Service.approvals(this.uid(req))});}catch(e){res.status(500).json({success:false,error:e.message});}}
 async decideApproval(req,res){try{res.json({success:true,approval:await Service.decideApproval(this.uid(req),req.params.id,req.body.decision,req.body.note)});}catch(e){res.status(400).json({success:false,error:e.message});}}
 async alerts(req,res){try{res.json({success:true,alerts:await Service.alerts(this.uid(req))});}catch(e){res.status(500).json({success:false,error:e.message});}}
 async resolveAlert(req,res){try{res.json({success:true,alert:await Service.resolveAlert(this.uid(req),req.params.id)});}catch(e){res.status(400).json({success:false,error:e.message});}}
 async event(req,res){try{res.status(202).json({success:true,event:await Service.ingestEvent(this.uid(req),req.body.type,req.body.payload,req.body.idempotency_key)});}catch(e){res.status(400).json({success:false,error:e.message});}}
}
module.exports=new AIAutomationController();
