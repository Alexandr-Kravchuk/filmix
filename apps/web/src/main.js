import './styles.css';
import { fetchFixedEpisode, fetchShow, getApiBaseUrl } from './api.js';

const elements = {
  title: document.getElementById('show-title'),
  status: document.getElementById('status'),
  video: document.getElementById('video')
};

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle('error', isError);
}

async function init() {
  try {
    setStatus('Loading show...');
    const show = await fetchShow();
    elements.title.textContent = show.title;
    setStatus('Loading english episode...');
    const episode = await fetchFixedEpisode();
    elements.video.src = new URL(episode.playUrl, `${getApiBaseUrl()}/`).toString();
    elements.video.load();
    setStatus(`Season ${episode.season}, episode ${episode.episode}, English`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

init();
