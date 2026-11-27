ARG NODE_IMAGE=node:24-alpine
FROM ${NODE_IMAGE}
WORKDIR /app
COPY dist/relay/main.cjs ./relay.cjs
ENV DRC_BIND=0.0.0.0 DRC_PORT=8788 DRC_STATE_FILE=/state/relay.json
RUN mkdir /state && chown node:node /state
USER node
EXPOSE 8788
ENTRYPOINT ["node", "/app/relay.cjs"]
