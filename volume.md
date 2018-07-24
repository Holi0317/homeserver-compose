# Volume settings
All persistent volumes are created using [local-persist](https://github.com/CWSpear/local-persist) docker plugin.

This approach gives us following advantages:
1. Single place in `docker-compose.yml` for changing volume location in host drive
   (vs multiple `bind` in volumes section of services)
2. Data is not deleted even if we issue `docker volume rm`
3. Easy to change volume location on host. Just change BASE\_PATH environment config

To change individual volume location on host drive (e.g. to a different directory than BASE\_PATH, or rename the directory),
change `mount_point` property in `docker-compose.yml` file.
