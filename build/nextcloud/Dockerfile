FROM nextcloud:fpm-alpine

RUN addgroup -g 2000 nextcloud \
  && adduser -u 2000 -D -G nextcloud nextcloud \
  && chown -R nextcloud:nextcloud /var/www \
  && apk add --no-cache \
    autoconf \
    alpine-sdk \
    supervisor \
    bzip2-dev \
    imagemagick-dev \
    libtool \
    libltdl \
  && docker-php-ext-install bz2 \
  && apk del autoconf alpine-sdk \
  && mkdir -p /var/log/supervisord /var/run/supervisord \
  && mv /var/spool/cron/crontabs/www-data /var/spool/cron/crontabs/nextcloud

COPY supervisord.conf /supervisord.conf
COPY www.conf /usr/local/etc/php-fpm.d/www.conf
COPY php.ini /usr/local/etc/php/

ENV NEXTCLOUD_UPDATE 1

CMD ["/usr/bin/supervisord", "-c", "/supervisord.conf"]
