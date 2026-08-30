'use strict';
const Auth = require('../services/TelegramAuthService');
const Controller={
 async requestCode(req,res){try{return res.json({success:true,...await Auth.requestCode(req.user.id,req.body.phone,req.body.automationRole)});}catch(e){return res.status(400).json({success:false,error:e.message});}},
 async verifyCode(req,res){try{return res.json({success:true,...await Auth.verifyCode(req.user.id,req.params.id,req.body.code)});}catch(e){return res.status(400).json({success:false,error:e.message});}},
 async verify2fa(req,res){try{return res.json({success:true,...await Auth.verify2fa(req.user.id,req.params.id,req.body.password)});}catch(e){return res.status(400).json({success:false,error:e.message});}},
 async status(req,res){try{return res.json({success:true,session:await Auth.status(req.user.id,req.params.id)});}catch(e){return res.status(400).json({success:false,error:e.message});}},
 async cancel(req,res){try{return res.json({success:true,...await Auth.cancel(req.user.id,req.params.id)});}catch(e){return res.status(400).json({success:false,error:e.message});}},
};
module.exports=Controller;
