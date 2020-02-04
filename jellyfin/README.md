# Jellyfin

Jellyfin is a media streaming service that support streaming movies, TV shows 
and Music.

Think of a self-hosted version of Netflix

# Configuration - First run

Nothing need to be configured in CLI. Navigate to the jellyfin page for 
first-run wizard and follow the instruction

# Adding video files

Media repository is at `${BASE_PATH}/jellyfin/media` on host. That is mounted 
to `/media` in jellyfin container.

Move media files to the host folder for scanning
