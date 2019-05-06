FROM linuxserver/letsencrypt:latest

COPY ssl.conf /etc/nginx/
COPY proxy.conf /etc/nginx/
COPY conf.d/ /etc/nginx/conf.d/
COPY default /defaults/
COPY well-known-matrix /var/www/synapse/.well-known/matrix/server
