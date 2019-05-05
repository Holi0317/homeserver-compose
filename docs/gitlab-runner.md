# Gitlab runner compose service
Run [Gitlab runner] inside docker compose environment.

[Gitlab runner]: https://docs.gitlab.com/runner/

## Introduction
This service would run a gitlab runner instance, accepting pipeline jobs from GitLab CI service.

This service assume use of docker for [runner executor]. For the reason, `docker.sock` unix
socket is mounted to the service.

[runner executor]: https://docs.gitlab.com/runner/executors/README.html

## First run
Before starting this service, you have to [register] the runner to Gitlab server.

[register]: https://docs.gitlab.com/runner/register/index.html

Run the following script for registration prompt from gitlab runner:

```bash
docker-compose run --rm gitlab-runner register
```

Follow the [instruction] and complete registration process. Remember to select `docker` for runner
executor.

[instruction]: https://docs.gitlab.com/runner/register/index.html#gnu-linux

## Get access to gitlab runner script
This show how to get `help` command for gitlab runner. Replace `help` with others for your purpose.
```bash
docker-compose run --rm gitlab-runner help
```

## Note on docker image size and containers number
Gitlab runner would spawn docker container for every build task. Please clean up stopped container periodically
using the following command:
```bash
docker container prune
```

For removing unused docker images, run the following command after removing unused containers:
```bash
docker image prune
```

Do note that the command may not remove all unused image. But should be sufficient for free up
host disk space.
