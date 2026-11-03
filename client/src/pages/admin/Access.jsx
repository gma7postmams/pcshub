import Users from './Users.jsx';
import Roles from './Roles.jsx';
import Groups from './Groups.jsx';

// Who (Users), what they can do (Roles) and which pages they can open (Groups) are one decision, so they live together.
const PARTS = [['users', 'Users', Users], ['roles', 'Roles', Roles], ['groups', 'Groups', Groups]];

export default function Access({ model, refreshModel, sub, onSub, go }) {
  const part = PARTS.some(([k]) => k === sub) ? sub : 'users';
  const Part = PARTS.find(([k]) => k === part)[2];
  return (
    <>
      <div className="tabs sub-tabs" role="tablist">
        {PARTS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={part === k} className={part === k ? 'on' : ''} onClick={() => onSub(k)}>{l}</button>)}
      </div>
      <Part model={model} refreshModel={refreshModel} go={go} />
    </>
  );
}
