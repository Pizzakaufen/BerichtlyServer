// Fingerabdrücke des TLS-Zertifikats für den Betrieb ohne Domain (eigenes Zertifikat für die IP-Adresse).
//
// Die App vertraut dann genau diesem Server über Certificate Pinning. Gepinnt wird der öffentliche Schlüssel
// (SHA-256 über SubjectPublicKeyInfo, Format "sha256/<Base64>" wie bei OkHttp) – er bleibt gleich, wenn das
// Zertifikat mit demselben Schlüssel verlängert wird.

import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const DEFAULT_TLS_CERT = '/etc/berichtly-server/tls/server.crt';

export interface TlsInfo {
  /** Pin des öffentlichen Schlüssels, z. B. "sha256/q7Rk…=" */
  pin: string;
  /** SHA-256-Fingerabdruck des Zertifikats (Hex mit Doppelpunkten), zum Abgleich im Browser */
  certSha256: string;
  subjectAltName: string;
  validFrom: Date;
  validTo: Date;
}

export function tlsInfo(pem: string | Buffer): TlsInfo {
  const cert = new X509Certificate(pem);
  const spki = cert.publicKey.export({ type: 'spki', format: 'der' });
  return {
    pin: 'sha256/' + createHash('sha256').update(spki).digest('base64'),
    certSha256: cert.fingerprint256,
    subjectAltName: cert.subjectAltName ?? '',
    validFrom: new Date(cert.validFrom),
    validTo: new Date(cert.validTo),
  };
}

export const tlsInfoFromFile = (path = DEFAULT_TLS_CERT) => tlsInfo(readFileSync(path));

/** Verbindungsdaten für die App (auch als QR-Code): Adresse und Pin. */
export const connectUri = (address: string, pin: string) =>
  `berichtly://server?url=${encodeURIComponent(`https://${address}`)}&pin=${encodeURIComponent(pin)}`;
