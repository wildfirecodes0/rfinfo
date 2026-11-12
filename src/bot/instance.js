const { Telegraf } = require('telegraf');
const cfg = require('../config');

const bot = new Telegraf(cfg.BOT_TOKEN, { handlerTimeout: 60_000 });

module.exports = bot;
