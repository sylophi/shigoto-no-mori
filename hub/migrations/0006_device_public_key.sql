-- Each device's static X25519 public key, base64url, sent with every
-- enrollment and replaced by the next one. The roster hands it to the
-- account's other devices, which encrypt to it. Rows enrolled before
-- it hold NULL: the Durable Object refuses their sockets, and the app
-- enrolls again to send one.
ALTER TABLE devices ADD COLUMN public_key TEXT;
