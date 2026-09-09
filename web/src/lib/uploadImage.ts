/* 图片上传：POST /api/uploads { data: dataUrl } → { ok, url }
 *
 * 后端契约：成功返回 { ok: true, url: '/uploads/xxx.png' }。
 * url 为相对路径（/uploads/...）时需拼后端源：vite 开发代理只转发 /api，
 * /uploads 静态资源不走代理，故补 http://localhost:4000 前缀。
 */
import { api } from '../api';

/** 上传产物静态源（后端地址；仅开发代理 /api，图片需直连后端） */
const UPLOAD_ORIGIN = 'http://localhost:4000';

/** 把后端返回的图片地址解析为可访问的绝对地址 */
export function resolveUploadUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return UPLOAD_ORIGIN + url;
  return url;
}

/** File → base64 data URL */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

/** 上传图片，返回可直接写入 <img src> 的地址 */
export async function uploadImageFile(file: File): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  const res: any = await api.post('/api/uploads', { data: dataUrl });
  const raw = res?.url || res?.data?.url;
  if (!raw) throw new Error('上传失败：接口未返回图片地址');
  return resolveUploadUrl(raw);
}
