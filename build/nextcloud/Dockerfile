FROM nextcloud:fpm

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
