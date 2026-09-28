# Connecting the Deadline Line to a real PBX (NOT done; needs the owner's approval)

The demo runs against a **throwaway Asterisk container** bound to 127.0.0.1. Nothing in this
repo touches the house PBX, and nothing should until the owner approves each step.
Reasons to wait: the house dialplan carries a live phone number, and there's an open decision
about call recording in `[from-pstn]`.

When approved, the smallest change is **one new extension in its own context**, reached only
by an explicit internal extension number first (never the public DID until tested):

```
; house PBX: /etc/asterisk/extensions_custom.conf (or wherever custom contexts live). Proposal only.
[deadline-line]
exten => 3323,1,Answer()
 same => n,Set(CALL_UUID=${SHELL(cat /proc/sys/kernel/random/uuid | tr -d '\n')})
 same => n,AudioSocket(${CALL_UUID},<bridge-host>:9092)
 same => n,Hangup()
```

Checklist, in order, each one approved separately:
1. **Back up** the current dialplan (`asterisk -rx "dialplan save"` or copy the conf files) and note how to roll back.
2. Confirm `app_audiosocket` is available on the house PBX's Asterisk version (18+).
3. Run the bridge on a LAN host the PBX can reach (`AUDIOSOCKET_HOST=<LAN IP>`), firewalled to the PBX only.
4. Add the context above and `include => deadline-line` **only in an internal-extensions context** so that only house phones can dial 3323. `dialplan reload`.
5. Test from a house handset. Only then decide whether a DID should route there.
6. Recording: the bridge keeps transcripts in memory only and writes nothing to disk. Align with the `[from-pstn]` recording decision before any public number points here.
