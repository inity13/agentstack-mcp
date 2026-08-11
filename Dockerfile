# AgentStack MCP — local stdio server image (self-host / Glama introspection).
# Build:  docker build -t agentstack-mcp .
# Run:    docker run --rm -i agentstack-mcp        # speaks MCP over stdio
FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
CMD ["node", "server.mjs"]
