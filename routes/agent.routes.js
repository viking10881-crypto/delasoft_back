// routes/agent.routes.js
const express = require("express");
const { auth } = require("../middleware/auth.middleware");
const {
  chat, confirmAction,
  getConversation, listConversations, deleteConversation,
} = require("../controllers/agent.controller");

const router = express.Router();

router.post("/chat",               auth, chat);
router.post("/confirm",            auth, confirmAction);          // nueva ruta
router.get("/conversations",       auth, listConversations);
router.get("/conversations/:id",   auth, getConversation);
router.delete("/conversations/:id",auth, deleteConversation);

module.exports = router;