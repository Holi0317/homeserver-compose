FROM linuxserver/letsencrypt:latest

COPY ssl.conf /etc/nginx/
COPY proxy.conf /etc/nginx/
COPY conf.d/ /etc/nginx/conf.d/
COPY default /defaults/
