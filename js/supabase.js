import "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";

const SUPABASE_URL = "https://tjlsuumswxowijxcvglc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_MmYGGGi4OOvhcQtCSKwOyw_OnzjJ7gW";

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Sync user settings to Supabase.
 * @param {object} settings 
 */
export async function syncSettingsToCloud(settings) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return; // not logged in

  const userId = session.user.id;
  
  const { error } = await supabase
    .from('user_settings')
    .upsert({ user_id: userId, settings });

  if (error) {
    console.error("Supabase sync error:", error);
  }
}

/**
 * Fetch settings from Supabase.
 * @returns {object|null}
 */
export async function fetchSettingsFromCloud() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;

  const userId = session.user.id;

  const { data, error } = await supabase
    .from('user_settings')
    .select('settings')
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    console.error("Supabase fetch error:", error);
    return null;
  }
  
  return data.settings;
}

/**
 * Extracts all 'ct_' prefixed keys from localStorage.
 */
export function exportLocalStorageForCloud() {
  const keys = Object.keys(localStorage).filter(k => k.startsWith('ct_'));
  const data = {};
  for(let k of keys) {
    const val = localStorage.getItem(k);
    try { 
      data[k] = JSON.parse(val); 
    } catch(e) { 
      data[k] = val; 
    }
  }
  return data;
}

/**
 * Injects cloud settings into localStorage.
 */
export function importCloudToLocalStorage(data) {
  if (!data) return;
  for(let k in data) {
    if(typeof data[k] === 'string') localStorage.setItem(k, data[k]);
    else localStorage.setItem(k, JSON.stringify(data[k]));
  }
}
