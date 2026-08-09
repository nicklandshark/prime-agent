/**
 * Instructions prepended to the first prompt of every newly created Cursor cloud
 * agent (never to follow-ups on resumed agents). They turn the VM into an
 * SSH-reachable environment: OpenSSH server + an outbound phone-home tunnel
 * (Tailscale when TAILSCALE_AUTHKEY is set, otherwise a no-auth bore.pub
 * reverse tunnel), then report the connection details as terminal fenced JSON.
 *
 * The recipe encodes empirical probe findings (cursor-cloud/docs/research/l2-probe.md):
 * bore.pub works for raw TCP where localhost.run's free tier does not; VMs
 * hibernate after ~13 min idle and wake with disk+processes intact, but tunnel
 * processes resume as zombies and must be killed and restarted (new port).
 * Keep in sync with BUILDER_PREAMBLE in the cursor-cloud prime-agent skill.
 * Toggle via CursorOptions.tunnel or CURSOR_CLOUD_TUNNEL=0.
 */
export const CURSOR_TUNNEL_PREAMBLE = `You are running inside a Cursor cloud agent VM. Before starting the actual task, make this VM reachable over SSH from the operator (phone-home architecture), then report the connection details.

HARD RULES
- Daemons must survive your shell exiting: launch with nohup, redirect output to log files.
- Never print the value of the TAILSCALE_AUTHKEY environment variable.

Known environment facts (measured, do not re-derive): you are user \`ubuntu\` with passwordless sudo; $HOME=/home/ubuntu; outbound TCP 22/443 works; tailscale is NOT preinstalled; python3 is 3.12, node is 22. The VM hibernates after ~13 min idle and wakes with disk and processes intact, but a restored tunnel process is a zombie — it must be killed and restarted, and the public port changes on every reconnect.

## 1. SSH server (always)

\`\`\`bash
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server
sudo ssh-keygen -A && sudo mkdir -p /run/sshd
sudo service ssh start || sudo /usr/sbin/sshd -p 22
\`\`\`

If the operator's SSH public key is present below as OPERATOR_PUBKEY, install it:
\`\`\`bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo "<OPERATOR_PUBKEY>" >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
\`\`\`
(If no key was provided, note that in the report; pubkey auth is the only auth allowed — set PasswordAuthentication no via /etc/ssh/sshd_config.d/.)

## 2. Tunnel — pick ONE branch

Branch selection: \`[ -n "$TAILSCALE_AUTHKEY" ] && echo tailscale || echo bore\`

### Tailscale branch (preferred when TAILSCALE_AUTHKEY is set)

\`\`\`bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo nohup tailscaled --tun=userspace-networking --statedir=$HOME/.tailscale-state >/tmp/tailscaled.log 2>&1 & sleep 3
sudo tailscale up --authkey="$TAILSCALE_AUTHKEY" --hostname=cursor-builder --timeout=60s
tailscale ip -4   # 100.x.y.z — this is the SSH host; sshd listens on all interfaces
\`\`\`

If TAILSCALE_AUTHKEY is absent you may instead run \`sudo tailscale up\` and report the interactive login URL it prints for the operator to authorize.

### bore.pub branch (fallback, no account or token needed)

Do NOT use localhost.run — its free tier only exposes HTTPS, never raw TCP, so SSH cannot traverse it. Use bore:

\`\`\`bash
curl -fsSL -o /tmp/bore.tgz https://github.com/ekzhang/bore/releases/download/v0.6.0/bore-v0.6.0-x86_64-unknown-linux-musl.tar.gz && tar xzf /tmp/bore.tgz -C /tmp && chmod +x /tmp/bore
nohup bash -c 'while true; do /tmp/bore local 22 --to bore.pub >> /tmp/tunnel.log 2>&1; sleep 5; done' >/dev/null 2>&1 &
\`\`\`

Poll /tmp/tunnel.log up to 60s for \`listening at bore.pub:PORT\` — that PORT (with host bore.pub) is the public SSH endpoint. The port changes on every reconnect; always report the freshest line.

## 3. Re-establish script

Save the exact working commands from steps 1-2 into $HOME/cursor-tunnel-up.sh and chmod +x it. A future run re-establishes everything after hibernation by first running \`pkill -f bore; pkill -f 'ssh -R'\` and then this one file.

## 4. Verify, then report

Verify end-to-end: generate a throwaway keypair, append its .pub to ~/.ssh/authorized_keys, ssh back into yourself through the tunnel endpoint (\`true\` must exit 0), then remove the throwaway key line and files.

Your report must END with a fenced json block, nothing after it. Report only values you verified:
- tailscale: {"ssh_host": "<tailscale ip -4>", "ssh_port": 22, "ssh_user": "ubuntu", "via": "tailscale", "tailscale_ip": "<same>"}
- bore.pub:  {"ssh_host": "bore.pub", "ssh_port": <assigned port>, "ssh_user": "ubuntu", "via": "bore.pub"}
- on failure: {"error": "<what failed, at which step, exact error>"}
If you printed an interactive Tailscale login URL, include it as "login_url" in the JSON.

## Actual task
`;
