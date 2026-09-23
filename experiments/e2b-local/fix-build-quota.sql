-- Local Embed's seeded 512 MiB quota cannot install a desktop.
-- This is build-time working space; min_free_disk_mb is a post-build target.
UPDATE tiers SET disk_mb = 4096 WHERE id = 'base_v1' AND disk_mb < 4096;
