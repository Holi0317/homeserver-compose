FROM nextcloud:fpm

RUN addgroup -g 2000 nextcloud; \
  adduser -D -H -u 2000 -G nextcloud -s /sbin/nologin -h / nextcloud; \ 
  sed "s/user = www-data/user = nextcloud/" /usr/local/etc/php-fpm.d/www.conf | sed "s/group = www-data//" > /usr/local/etc/php-fpm.d/www.conf; \
  chown -R nextcloud:nextcloud /var/www; \
  apk add --nocache \
    autoconf \
    alpine-sdk \
    supervisor \
    bzip2-dev \
    imagemagick-dev \
    libtool \
    libltdl; \
  pecl install imagick; \
  docker-php-ext-enable imagick; \
  docker-php-ext-install bz2

RUN apt-get update && apt-get upgrade -y && apt-get install -y \
    supervisor \
    libbz2-dev \
    libmagickwand-dev \
  && rm -rf /var/lib/apt/lists/* \
  && pecl install imagick \
  && docker-php-ext-install bz2 \
  && docker-php-ext-enable imagick

COPY supervisord.conf /supervisord.conf

RUN mkdir /var/log/supervisord /var/run/supervisord

CMD ["/usr/bin/supervisord", "-c", "/supervisord.conf"]
