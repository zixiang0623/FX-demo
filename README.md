# FX-demo
AIがMCPで操作できる、FX疑似体験アプリ(Cloudflare Workers + Durable Object)。

- UI: `/` ・ MCP: `POST /mcp`(Streamable HTTP / JSON-RPC)
- ツール: get_market / get_price_history / get_account / place_order / close_position / close_all / get_news / get_activity / reset_account
- 開発: `npm i && npx wrangler dev` ・ 公開: `npx wrangler deploy`
