FROM nginx:alpine

RUN apk add --no-cache musl-locales
ENV LANG=en_US.UTF-8

RUN adduser -u 82 -D -G www-data www-data

COPY nginx.conf /etc/nginx/nginx.conf
