// Where an address is: "Quezon City, Philippines" with the network (provider and AS number) under it. Only a System Admin is ever sent
// this (the server leaves it out for everybody else), so wherever it is missing nothing is drawn.
export function Geo({ g }) {
  if (!g) return null;
  // always on its own line under the address, like a located one (an inline label ran into the IP: "10.0.0.10Private network")
  const own = { display: 'block', fontSize: '0.85em', lineHeight: 1.3 };
  if (g.private) return <span className="dim geo" style={own}>Private network</span>;
  const where = [g.city, g.country].filter(Boolean).join(', ');
  if (!where && !g.network) return <span className="dim geo" style={own}>Location unknown</span>;
  return (
    <span className="geo" style={{ display: 'block', fontSize: '0.85em', lineHeight: 1.3 }} title={`Network location, not the person's: where the provider registers this address. ${[g.region, g.country, g.network].filter(Boolean).join(' · ')}`}>
      {where ? <span>{where}</span> : null}
      {g.network ? <span className="dim" style={{ display: 'block' }}>{g.network}</span> : null}
    </span>
  );
}

/** The credit DB-IP asks for wherever its data is shown, plus how to get the data when it is not installed yet. */
export function GeoNote({ status }) {
  if (!status) return null;
  return (
    <div className="dim mt-12" style={{ fontSize: '0.85em' }}>
      {status.installed
        ? <>Locations are the <strong>network&apos;s</strong> (where the provider registers or routes the address), not where the person is; a phone network, VPN or head-office link can show another city. Looked up on this server, nothing is sent out. <a href="https://db-ip.com" target="_blank" rel="noreferrer noopener">IP Geolocation by DB-IP</a></>
        : <>Locations are not available yet: on the server run <span className="mono">npm run geoip:update</span> (free, once a month); no restart is needed.</>}
    </div>
  );
}
