import { useRef } from 'react';
import { post } from '../../lib/api.js';
import { useToast } from '../../components/ui.jsx';

// Export JSON / Import JSON buttons, as on the Dropdowns tab. `path` is e.g. '/api/admin/groups'; `summary(result)` words the toast.
export default function JsonTools({ path, summary, onDone }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const importFile = async (file) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    let json;
    try { json = JSON.parse(await file.text()); } catch (e) { toast('That file is not valid JSON', 'err'); return; }
    try {
      const r = await post(`${path}/import`, json);
      const bad = r.errors && r.errors.length ? r.errors : null;
      toast(bad ? `${summary(r)}. ${bad[0]}${bad.length > 1 ? ` (+${bad.length - 1} more)` : ''}` : summary(r), bad ? 'err' : undefined);
      if (onDone) onDone();
    } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <>
      <a className="btn" href={`${path}/export`} download>Export JSON</a>
      <button type="button" className="btn" onClick={() => fileRef.current && fileRef.current.click()}>Import JSON</button>
      <input ref={fileRef} type="file" hidden onChange={(e) => importFile(e.target.files[0])} />
    </>
  );
}
