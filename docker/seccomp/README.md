# Catalog Packager seccomp

`catalog-packager.json` retains the Docker default seccomp policy from [moby/profiles commit 4b8214fc4971e06172938a1f1554ccff6647ee80](https://raw.githubusercontent.com/moby/profiles/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json). Original source SHA-256: `6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6`. Upstream license: [LICENSE.moby](LICENSE.moby).

Four appended rules allow the bwrap namespace/mount setup: clone without cgroup namespaces; unshare restricted to mount, user, PID, network, IPC, UTS and CLONE_FS; mount/umount2/pivot_root; setns restricted to user namespaces. Other default denials remain. The profile applies only to catalog-service, with all outer capabilities dropped and no-new-privileges retained. It is not a privileged-container policy.

The full deployment and AppArmor prerequisites are in [packager-runtime-verification](../../docs/packager-runtime-verification.md). No image build or target-host execution is implied by this file.
