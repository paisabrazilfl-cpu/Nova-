import { Router, type IRouter } from "express";
import healthRouter from "./health";
import novaConfigRouter from "./nova-config";
import scratchpadRouter from "./scratchpad";
import workTreeRouter from "./work-tree";
import integrationsRouter from "./integrations";
import knowledgeRouter from "./knowledge";
import openaiProxyRouter from "./openai-proxy";
import voiceRouter from "./voice";
import { requireWtAuth } from "../lib/work-tree-auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(novaConfigRouter);
router.use(voiceRouter);
router.use(scratchpadRouter);
router.use(workTreeRouter);
// The credential store and knowledge base are sensitive (they hold Robert's API
// tokens and private notes), so they sit behind the same PIN gate as Work Tree.
// One /unlock (cookie scoped to /api) covers all three. The gate is scoped to
// these path prefixes ONLY — mounting requireWtAuth without a path turns it into
// catch-all middleware that locks every later route (including the chat proxy).
// Knowledge context is still injected into chat server-side in-process, which
// does not pass through these gated HTTP routes.
router.use(["/integrations", "/knowledge"], requireWtAuth);
router.use(integrationsRouter);
router.use(knowledgeRouter);
router.use(openaiProxyRouter);

export default router;
