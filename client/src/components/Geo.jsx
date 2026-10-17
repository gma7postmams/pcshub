// Where an address is: "Quezon City, Philippines" with the network (provider and AS number) under it. Only a System Admin is ever sent
// this (the server leaves it out for everybody else), so wherever it is missing nothing is drawn.
export function Geo({ g, block }) {
  if (!g) return null;
  if (g.private) return <span className="dim geo" style={block ? { display: 'block' } : undefined}>Private network</span>;
  const where = [g.city, g.country].filter(Boolean).join(', ');
  if (!where && !g.network) return <span className="dim geo" style={block ? { display: 'block' } : undefined}>Location unknown</span>;
  return (
    <span className="geo" style={{ display: 'block', fontSize: '0.85em', lineHeight: 1.3 }} title={[g.region, g.country, g.network].filter(Boolean).join(' · ')}>
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
        ? <>Locations are approximate and looked up on this server, nothing is sent out. <a href="https://db-ip.com" target="_blank" rel="noreferrer noopener">IP Geolocation by DB-IP</a></>
        : <>Locations are not available yet: on the server run <span className="mono">npm run geoip:update</span> (free, once a month); no restart is needed.</>}
    </div>
  );
}
