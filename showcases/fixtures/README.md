# Showcase fixtures

Local-developer fixtures consumed by the docker-based real-provider
showcases. None of these files have any production purpose — they
exist only to drive `pnpm docker:up`'s containers.

## `ssh-test-key` / `ssh-test-key.pub`

Test keypair for the OpenSSH service in `showcases/docker-compose.yml`.
The private half (`ssh-test-key`) is **gitignored** — generate it once
on each machine that runs the showcase:

```bash
ssh-keygen -t ed25519 -N '' -C 'noydb showcase' -f showcases/fixtures/ssh-test-key
```

The public half (`ssh-test-key.pub`) is mounted into the sshd
container's `authorized_keys` via the compose file. It is safe to
commit — losing the matching private key locks no one out of any real
system.

If you accidentally commit the private half, rotate it: the keypair
is bound to nothing of value, but a leaked private key in repo
history is still a sloppy artefact to leave behind.
