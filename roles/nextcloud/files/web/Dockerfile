FROM nginx:alpine

RUN addgroup -g 2000 nextcloud \
  && adduser -u 2000 -D -G nextcloud nextcloud

COPY nginx.conf /etc/nginx/nginx.conf
