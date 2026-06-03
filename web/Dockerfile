FROM node:20-alpine AS builder
RUN corepack enable && corepack prepare yarn@1.22.22 --activate
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
# Optional Google Tag Manager container ID. Unset (the default) => no analytics
# is baked into the build, so self-hosters report nothing. Our deployment passes
# it as a build arg. Must be set before `yarn build` since Vite inlines it.
ARG VITE_GTM_ID=
ENV VITE_GTM_ID=$VITE_GTM_ID
RUN yarn build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# nginx:alpine's entrypoint runs envsubst over /etc/nginx/templates/*.template
# at container start, writing the result to /etc/nginx/conf.d/. Listing the
# only var we want substituted keeps nginx's own $vars (resolver, etc.) intact.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
ENV NGINX_ENVSUBST_TEMPLATE_SUFFIX=.template
ENV NGINX_ENVSUBST_FILTER='^API_PORT$'
EXPOSE 80
