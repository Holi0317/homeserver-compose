# ddns

Setup [cf-ddns] service in docker as DDNS service for cloudflare.

[cf-ddns]: https://gitlab.com/holi0317/cf-ddns/

## Synopsis

- Create configuration file for `cf-ddns` with ansible variables
- Create docker container running `cf-ddns` in cron mode

## Requirements

- Should be distribution agnostic
- Ansible >= 2.10 (Tested on 2.10)

## Role Variables

### `storage_root`

- Type: `string`
- Required: Yes

Path prefix for all persistent data.

### `ddns_cf_api_token`

- Type: `string`
- Required: Yes

Cloudflare API token for this bot. Check [cf-ddns documentation] for details.

This should be a secret variable.

[cf-ddns documentation]: https://gitlab.com/holi0317/cf-ddns/-/blob/master/README.md

### `ddns_cf_zone_id`

- Type: `string`
- Required: Yes

Cloduflare Zone ID for this bot. Check [cf-ddns documentation] for details.

### `ddns_domains`

- Type: `List of string`
- Required: Yes

List of domains to be set for DDNS

## Example Playbook

Including an example of how to use your role (for instance, with variables passed in as parameters) is always nice for users too:

```yaml
- hosts: "servers"
  roles:
    - role: "ddns"
      vars:
        ddns_cf_api_token: "hunter2"
        ddns_cf_zone_id: "123"
        ddns_domains:
          - "example.com"
          - "git.example.com"
```

## License

MIT
