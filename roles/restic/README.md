# restic

Setup [restic] backup

[restic]: https://restic.readthedocs.io/en/stable/index.html

## Synopsis

- Create restic user
- Install restic binary
- Setcap on restic binary
- Install backup shell script
- Setup systemd unit and timer to run restic periodically

## Requirements

- Fedora
- Ansible >= 2.13
- Backing up to Backblaze B2 bucket

## Role Variables

### `restic_version`

- Type: `string`
- Required: Yes
- Example: `0.14.0`

Restic version to be downloaded. See [restic release](https://github.com/restic/restic/releases)
for the latest available version.

### `restic_password`

- Type: `string`
- Required: Yes

Password for encrypting restic repository.

This should be a secret variable.

### `restic_repository`

- Type: `string`
- Required: Yes

Repository path for backup. This should be something like `b2:bucket_name/path`.

Note that we only support B2 backup.

### `b2_account_id`

- Type: `string`
- Required: Yes

Account ID got from Backblaze.

### `b2_account_key`

- Type: `string`
- Required: Yes

Account key got from Backblaze.

This should be a secret variable.

## Example Playbook

Including an example of how to use your role (for instance, with variables passed in as parameters) is always nice for users too:

```yaml
- hosts: "servers"
  roles:
    - role: "restic"
      vars:
        restic_version: "0.14.0"
        restic_password: "hunter2"
        restic_repository: "b2:asdf"
        b2_account_id: "asdf"
        b2_account_key: "hunter2"
```

## License

MIT
