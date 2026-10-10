import { useState } from 'react';
import Roles from './Roles.jsx';
import Groups from './Groups.jsx';

// Roles (what a user can do) and Groups (which pages they can open) are two halves of one decision, so they live together.
const PARTS = [['roles', 'Roles', Roles, 'What people can do'], ['groups', 'Groups', Groups, 'Which pages they can open']];

export default function Access({ model, refreshModel, start = 'roles' }) {
  const [part, setPart] = useState(start);
  const Part = (PARTS.find(([k]) => k === part) || PARTS[0])[2];
  return (
    <>
      <div className="tabs sub-tabs" role="tablist">
        {PARTS.map(([k, l, , hint]) => <button key={k} type="button" role="tab" aria-selected={part === k} className={part === k ? 'on' : ''} onClick={() => setPart(k)}>{l}</button>)}
      </div>
      <Part model={model} refreshModel={refreshModel} />
    </>
  );
}
