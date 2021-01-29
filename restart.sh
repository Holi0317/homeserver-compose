#!/usr/bin/env bash

set -e

re() {
  cd $1
  docker-compose down && docker-compose up -d
  cd .. 
}

re gitea
re nextcloud
re peertube
re traefik
re ddns
