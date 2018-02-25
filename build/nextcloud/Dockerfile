FROM nextcloud:fpm

COPY supervisord.conf /supervisord.conf

RUN apt-get update && apt-get upgrade -y && apt-get install -y \
    supervisor \
    libbz2-dev \
  && rm -rf /var/lib/apt/lists/* \
  && docker-php-ext-install bz2 \
  && mkdir /var/log/supervisord /var/run/supervisord \
  && chown www-data:www-data /var/log/supervisord /var/run/supervisord /supervisord.conf

USER www-data

CMD ["/usr/bin/supervisord", "-c", "/supervisord.conf"]
