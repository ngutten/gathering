# Gathering Security Guide

This document covers what users and server administrators should know about Gathering's end-to-end encryption, what it protects against, what it doesn't, and what choices are available.

---

## How Encryption Works in Gathering

Gathering uses end-to-end encryption (E2E) so that the server never sees the plaintext content of encrypted messages, files, or topics. Encryption happens entirely in your browser or Tauri client using the libsodium cryptography library.

Each user has a **keypair** (a private key and a public key). Each encrypted channel has a **channel key** that is shared among its members. Messages are encrypted with the channel key before they leave your device, and can only be decrypted by someone who has that key.

The server stores and relays encrypted data, but cannot read it.

---

## For Users

### Setting Up Your Key

When you first log in, you have no encryption key. You need to generate one before you can participate in encrypted channels:

1. Click **Generate Key** in the sidebar
2. Your key fingerprint (a short hex string) appears in green

This key is stored in your browser's local storage. **If you clear your browser data, switch browsers, or use a new device, you will lose this key** unless you back it up.

### Backing Up Your Key

You have two options:

**Export to file** -- Click **Export Key** in the sidebar. This downloads a JSON file containing your private key. Store it somewhere safe (a password manager, an encrypted drive, etc.). You can restore it later with **Import Key**.

**Server-side sync** -- Click **Sync** in the sidebar to encrypt your private key with a passphrase and store the encrypted blob on the server. The server cannot decrypt it. When you log in from a new device, you'll be prompted to enter your passphrase to restore your key.

If you lose your key and have no backup, you permanently lose access to all previously encrypted messages. There is no recovery mechanism.

### Which Backup Method Should I Use?

**File export** is the safest option. Your key never touches the server, and its security depends entirely on how you store the file.

**Server-side sync** is more convenient for multi-device use but involves a tradeoff: your encrypted private key is stored on the server. Its security depends on the strength of your passphrase. A weak passphrase could be brute-forced if the server's database is compromised. Use a strong, unique passphrase (ideally from a password manager).

Some servers may disable the sync feature entirely (the Sync button will be hidden). On these servers, file export is the only option.

### Encrypted Channels

Anyone can create an encrypted channel by checking the E2E checkbox when creating a channel. Once created, a channel's encryption status cannot be changed.

When you create an encrypted channel, only you have the key initially. Other users must request access, and you (or any other member who has the key) must approve their request.

### Approving Key Requests

When someone requests access to an encrypted channel you're in, a **Key Request** notification appears in your sidebar. You'll see:

- Who is requesting access
- Their key fingerprint
- Whether you've seen this user's key before

**Trust on First Use (TOFU):** The first time you see a user's public key, it's pinned locally. If their key later changes (which could indicate a compromised account or a man-in-the-middle attack), you'll see a red warning. Do not approve mismatched keys without verifying out-of-band (e.g., asking the person directly through another channel).

Denying a request suppresses further requests from that user for 24 hours.

### Verifying Keys

Your key fingerprint is displayed in the sidebar. You can share it with other users through a trusted channel (in person, phone call, different messaging app) so they can confirm that the key they see for you matches. This protects against a compromised server substituting fake keys.

Gathering currently uses a TOFU model: keys are trusted on first contact and flagged if they change. Out-of-band verification strengthens this significantly but is optional.

### Re-Keying a Channel

If you believe a channel key has been compromised, you can re-key the channel from channel settings. This generates a new key and distributes it to all current members whose keys pass the TOFU check.

**Warning:** Re-keying makes all previous messages, topics, and files in that channel permanently unreadable to everyone. This cannot be undone.

### What the Green [E2E] Badge Means

Messages encrypted end-to-end show a green `[E2E]` badge next to the timestamp. This means the message was encrypted on the sender's device and decrypted on yours. The server only saw ciphertext.

If you see `[Encrypted - key unavailable]`, you're in an encrypted channel but don't have the key yet. Click **Request Key** in the channel header.

If you see `[Encrypted - decryption failed]`, the message may be corrupted or encrypted with a different key version.

---

## For Server Administrators

### What the Server Can and Cannot See

**The server can see:**
- Who is talking to whom (channel membership, message metadata, timestamps)
- Message sizes and frequency
- Which channels are encrypted
- Unencrypted messages in non-encrypted channels
- Encrypted public keys (but not private keys)
- File metadata (names, sizes, upload times) even for encrypted files

**The server cannot see:**
- The plaintext content of encrypted messages
- The plaintext content of encrypted files
- Users' private keys
- Channel encryption keys (these are encrypted per-user with public key cryptography)

### Server-Side Key Backup

When enabled (the default), users can store passphrase-encrypted copies of their private keys on the server. The server stores an opaque blob encrypted with Argon2id key derivation -- it cannot decrypt it.

However, if your server's database is compromised, an attacker could attempt offline brute-force attacks against users' backup passphrases. Users who choose weak passphrases are at risk.

To disable this feature, set `allow_key_backup` to `false` in `config.json`. This hides the Sync button and rejects backup requests. Users can still export keys to files manually.

```json
{
  "allow_key_backup": false
}
```

**Recommendation:** On servers where participants face high-risk threat models, disable server-side key backup and instruct users to use file export instead.

### Browser Client vs. Standalone Client

**Browser client:** The server serves the JavaScript code that handles encryption. If the server is compromised, an attacker could serve modified code that exfiltrates encryption keys. This is a fundamental limitation of all browser-based end-to-end encryption.

Gathering includes a service worker that pins the SHA-256 hashes of JavaScript files on first load and warns users if files change on subsequent visits. This protects established users against post-compromise code injection, but does not protect new users loading the client for the first time from a compromised server.

**Standalone (Tauri) client:** The code is bundled at build time and does not come from the server. A compromised server cannot modify the client code. This is the recommended option for users who need strong E2E guarantees.

**Recommendation:** For high-security deployments, recommend that users install the Tauri client rather than relying on the browser. The browser client's code integrity protection (service worker) is a mitigation, not a guarantee.

### What a Compromised Server Can Do

Even with E2E encryption, a compromised server could:

- **Substitute public keys:** When a user requests another user's public key, the server could return a key controlled by the attacker, enabling a man-in-the-middle attack on future key exchanges. TOFU pinning on the client detects this if the users have communicated before, but not on first contact.
- **Forge key requests:** The server could fabricate key request notifications to trick users into sharing channel keys with attacker-controlled keys. Verifying fingerprints out-of-band mitigates this.
- **Drop or delay messages:** The server can selectively withhold messages without detection.
- **Serve malicious code (browser only):** As described above, the browser client's code comes from the server.
- **Attempt offline attacks on key backups:** If key backup is enabled and the database is exfiltrated.

A compromised server **cannot:**
- Decrypt previously encrypted messages (unless it also obtains a user's private key)
- Forge messages that pass client-side decryption (they would fail authentication)

### Operational Recommendations

1. **Restrict server access.** The data directory contains the database, TLS keys, and (if enabled) encrypted key backups. Protect it accordingly.
2. **Use real TLS certificates.** Self-signed certificates are generated automatically for convenience, but production deployments should use certificates from a trusted CA (e.g., Let's Encrypt) or a reverse proxy.
3. **Review admin accounts.** The `admins` list in `config.json` grants full server control. Keep it minimal.
4. **Consider disabling key backup** (`allow_key_backup: false`) if your threat model includes server compromise.
5. **Recommend the Tauri client** to users who need the strongest E2E guarantees.

---

## Privacy and Anonymity

Gathering is designed for groups of people who know each other (well enough to exchange invite codes), but who may not want the server to be a roadmap connecting their activity to real-world identities. The goal is that seizing the server or a client device reveals as little as possible about who the users are outside of Gathering.

### What Gathering Does by Default

Several privacy protections are built in and enabled by default:

**No identifying information required.** Registration requires only a username and password. No email, phone number, or real name is collected.

**Logs do not contain usernames.** Server log output records operational events (startup, file uploads, logins) without including usernames or other user-identifying information. Log entries use generic descriptions like "User logged in" rather than "alice logged in."

**Filenames are stripped on encrypted uploads.** When a file is uploaded to an encrypted channel, the server stores only a generated ID and file extension — not the original filename. This prevents metadata like `john_smith_contract.pdf` from appearing in the database. (Unencrypted uploads retain the original filename, since the content itself is already visible to the server.)

**Invite codes do not track who used them.** When an invite code is consumed, the server records that it was used but not which user used it. This prevents the database from containing a social graph of who invited whom.

**Self-signed certificates do not embed network IPs.** When generating self-signed TLS certificates, the server does not probe for or embed the host's LAN IP address. The certificate contains only `localhost` and `127.0.0.1` as subject alternative names.

**IP addresses are not stored persistently.** IPs are held in memory only for rate limiting (login and registration endpoints) and are purged after approximately two minutes. They are never written to the database or logs.

### What Remains Visible

Even with these protections, some metadata is inherent to the system's operation:

**The database contains activity metadata.** Usernames, channel membership, message timestamps, and message authorship are stored in the SQLite database. An adversary with access to the database can see who talked to whom and when, even if encrypted message content is unreadable.

**Usernames are persistent.** A username is linked to all of a user's activity — messages, file uploads, channel membership, DMs, reactions. If a username can be connected to a real identity (e.g., the user chose their real name, or told someone), all their activity is linked.

**Unencrypted channels store plaintext.** Only encrypted channels protect message content. Unencrypted channels store messages in the clear in the database.

**File metadata for unencrypted uploads.** Original filenames, file sizes, MIME types, and uploader usernames are stored for unencrypted file uploads.

### Steps Server Admins Can Take

Beyond the built-in defaults, admins can take additional steps depending on their threat model:

**Run as a Tor hidden service.** Gathering is a single binary that serves both HTTPS and WebSocket traffic. Running it behind Tor hides the server's physical location and prevents network observers from seeing who connects to it. When using Tor, provide your own TLS certificates or use Tor's built-in transport encryption and disable the HTTP redirect port.

**Use full-disk encryption on the server.** If the server hardware could be physically seized, full-disk encryption (LUKS, FileVault, BitLocker) protects the database and all stored files at rest. Without the disk encryption passphrase, the data is unreadable.

**Use encrypted channels for all sensitive communication.** Encourage or require users to use encrypted channels. Unencrypted channels should be treated as readable by anyone with server access.

**Set short message TTLs.** Message TTL (time-to-live) causes messages to be automatically deleted after a set period. This limits the window of exposure if the database is later compromised. Users set TTL per-message, but admins can recommend short TTLs as a community norm.

**Disable key backup.** Set `allow_key_backup: false` in config.json to prevent passphrase-encrypted private keys from being stored on the server. This eliminates one avenue of offline attack at the cost of user convenience.

**Limit the data directory's permissions.** The `gathering-data/` directory contains the database, uploaded files, TLS keys, and config. Restrict filesystem permissions so only the server process can read it.

**Instruct users to choose non-identifying usernames.** The most common way anonymity is broken is users choosing recognizable usernames. A username like `j.smith` or a handle used on other platforms defeats all technical protections.

**Consider periodic database purges.** For high-security deployments, periodically deleting old messages and inactive accounts limits the amount of historical metadata available in a breach. This can be done manually via SQLite or by setting short TTLs on all messages.

### Steps Users Can Take

**Choose a username that isn't linked to your other identities.** Don't reuse handles from other platforms.

**Use a VPN or Tor Browser** when connecting to the server, especially if you don't want the server operator (or your ISP) to know your IP address.

**Use encrypted channels** for any conversation you wouldn't want read by someone with server access.

**Set message TTLs** on sensitive messages so they are automatically deleted.

**Be mindful of file uploads.** Filenames are stripped on encrypted channels, but file content and metadata (EXIF data in photos, author fields in documents) may still contain identifying information. Scrub files before uploading if this matters to you.

**Use the Tauri client** rather than the browser. The browser client's code comes from the server; the Tauri client's code is bundled at build time and cannot be tampered with by a compromised server.

---

## Threat Model Summary

| Threat | Protected? | Notes |
|--------|-----------|-------|
| Server reads encrypted messages | Yes | Server only sees ciphertext |
| Server reads unencrypted channels | No | Only encrypted channels are protected |
| Database breach exposes messages | Partially | Encrypted messages are safe; unencrypted messages and metadata are exposed |
| Database breach exposes key backups | Partially | Backups are passphrase-encrypted (Argon2id); security depends on passphrase strength |
| Compromised server injects code (browser) | Partially | Service worker detects changes for returning users; new users are unprotected |
| Compromised server injects code (Tauri) | Yes | Client code is bundled at build time |
| Man-in-the-middle on key exchange | Partially | TOFU pinning detects key changes after first contact; out-of-band verification recommended |
| Targeted message dropping/delay | No | Server controls message routing |
| Traffic analysis (who talks to whom, when) | No | Metadata is visible to the server; use Tor to hide connection metadata from network observers |
| Database breach reveals user identities | Partially | No real names or emails stored; usernames and activity patterns remain |
| Invite codes reveal social graph | Yes | Used-by field is not recorded |
| Server logs reveal usernames | Yes | Logs contain only operational events, no usernames |
| Lost device, no key backup | Data loss | Encrypted history is permanently inaccessible |

---

## What Gathering Does Not Provide

- **Perfect forward secrecy.** Channel keys are long-lived. If a key is compromised, all past and future messages using that key are exposed (until the channel is re-keyed).
- **Full metadata protection.** The server knows who is in which channels, who is online, and message timestamps. Using Tor hides network-level metadata but not application-level metadata.
- **Protection against a compromised client device.** If your device is compromised, your keys are exposed regardless of the encryption protocol.
- **Automatic key rotation.** Channel keys do not rotate automatically. Re-keying is a manual, destructive operation.
- **Sender anonymity within channels.** Other channel members can see who sent each message. Anonymous posting is not supported.

---

## Recommended User Workflow

1. **Choose a non-identifying username** that isn't linked to your other online identities.
2. **Generate your key** on your primary device.
3. **Export it to a file** and store the file securely (password manager, encrypted USB drive).
4. **Verify fingerprints** with people you communicate with regularly, using a channel you trust (in person, phone, etc.).
5. **Pay attention to key mismatch warnings.** Don't approve key requests with mismatched fingerprints without verifying.
6. **Use the Tauri client** if your security needs are high.
7. If using multiple devices, either **import the same key file** on each device, or use **Sync** with a strong passphrase.
8. **Use encrypted channels** and **set message TTLs** for sensitive conversations.
