#!/bin/bash
docker pull php:8-fpm-alpine

docker buildx build --platform linux/arm64/v8,linux/amd64 ./file/php --push -t gtary/ssp:php
