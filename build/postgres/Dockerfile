FROM postgres:alpine

RUN addgroup -g 2000 \
  adduser -D -H -u 2000 -G nextcloud -s /sbin/nologin -h / nextcloud

USER nextcloud
