# Polaris
[Polaris] is a self-hosted music streaming service with Android client support.

[Polaris]: https://github.com/agersant/polaris

# First run

## Preparation
Before starting the polaris service, create a directory owned by UID and GID `100` at `${BASE_PATH}/polaris-db`

## Initialization
Navigate to the host and finish startup wizard.

For Music source, the path is `/music`

# Adding music to library
Put music to `${BASE_PATH}/polaris-music`. As long as UID `100` or GID `100` could read it, it is in good shape.

Trigger scan from web UI > settings > collection
