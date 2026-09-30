import { useState, useEffect } from 'react'
import axios from 'axios'
import { Line } from 'react-chartjs-2'
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Title, Tooltip, Legend, Filler,
} from 'chart.js'
import { FiLink, FiCopy, FiExternalLink, FiActivity } from 'react-icons/fi'
import './App.css'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, Filler)

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'

export default function App() {
  const [longUrl, setLongUrl] = useState('')
  const [expiresInSeconds, setExpiresInSeconds] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [lastResult, setLastResult] = useState(null)
  const [links, setLinks] = useState([])
  const [copiedCode, setCopiedCode] = useState(null)

  const fetchLinks = async () => {
    try {
      const res = await axios.get(`${API_URL}/api/links`)
      setLinks(res.data)
    } catch {
      // Left blank on purpose: a failed background refresh shouldn't
      // interrupt someone who is mid-way through using the form.
    }
  }

  useEffect(() => {
    fetchLinks()
    const interval = setInterval(fetchLinks, 3000) // catches the batched click flush
    return () => clearInterval(interval)
  }, [])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!longUrl.trim()) return
    setSubmitting(true)
    setLastResult(null)
    try {
      const body = { longUrl }
      if (expiresInSeconds) body.expiresInSeconds = Number(expiresInSeconds)
      const res = await axios.post(`${API_URL}/api/shorten`, body)
      setLastResult({ ok: true, ...res.data })
      setLongUrl('')
      setExpiresInSeconds('')
      fetchLinks()
    } catch (err) {
      const message = err.response?.data?.error || 'Could not shorten that link.'
      setLastResult({ ok: false, message })
    } finally {
      setSubmitting(false)
    }
  }

  const handleCopy = (shortUrl, code) => {
    navigator.clipboard.writeText(shortUrl)
    setCopiedCode(code)
    setTimeout(() => setCopiedCode(null), 1500)
  }

  const chart = {
    labels: [...links].reverse().map((l) => new Date(l.createdAt).toLocaleDateString()),
    datasets: [
      {
        label: 'Clicks',
        data: [...links].reverse().map((l) => l.clicks),
        borderColor: '#4AD3C9',
        backgroundColor: 'rgba(74, 211, 201, 0.1)',
        fill: true,
        tension: 0.35,
        pointRadius: 3,
      },
    ],
  }

  return (
    <div className="app-shell">
      <nav className="navbar">
        <div className="nav-title">
          <FiLink size={18} />
          <span>URL Shortener</span>
        </div>
        <span className="nav-tag">Redis cache + rate limiting + async analytics</span>
      </nav>

      <main className="dashboard-grid">
        <section className="col col-left">
          <form className="submit-form" onSubmit={handleSubmit}>
            <label>Shorten a link</label>
            <input
              value={longUrl}
              onChange={(e) => setLongUrl(e.target.value)}
              placeholder="https://example.com/very/long/path"
              disabled={submitting}
            />
            <label className="secondary-label">Expires in (seconds, optional)</label>
            <input
              value={expiresInSeconds}
              onChange={(e) => setExpiresInSeconds(e.target.value)}
              placeholder="e.g. 3600"
              disabled={submitting}
            />
            <button type="submit" disabled={submitting}>
              {submitting ? 'Shortening...' : 'Shorten'}
            </button>

            {lastResult && lastResult.ok && (
              <div className="result-box ok">
                <a href={lastResult.shortUrl} target="_blank" rel="noreferrer">{lastResult.shortUrl}</a>
                <button className="copy-btn" onClick={() => handleCopy(lastResult.shortUrl, lastResult.shortCode)}>
                  <FiCopy size={13} /> {copiedCode === lastResult.shortCode ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
            {lastResult && !lastResult.ok && (
              <p className="result-box error">{lastResult.message}</p>
            )}
          </form>
        </section>

        <section className="col col-middle">
          <div className="panel">
            <h2><FiActivity size={14} /> Clicks by link (created order)</h2>
            <Line
              data={chart}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: '#F5F5F3', font: { family: 'monospace', size: 11 } } } },
                scales: {
                  x: { ticks: { color: '#6B6B70', font: { size: 9 } }, grid: { color: '#1E1E22' } },
                  y: { ticks: { color: '#6B6B70' }, grid: { color: '#1E1E22' }, beginAtZero: true },
                },
              }}
            />
          </div>
        </section>

        <section className="col col-right">
          <div className="panel">
            <h2>Recent Links</h2>
            <div className="table-scroll">
              <table className="link-table">
                <thead>
                  <tr><th>Code</th><th>Clicks</th><th></th></tr>
                </thead>
                <tbody>
                  {links.length === 0 && (
                    <tr><td colSpan={3} className="empty-row">No links yet</td></tr>
                  )}
                  {links.map((link) => (
                    <tr key={link._id}>
                      <td className="ellipsis" title={link.longUrl}>{link.shortCode}</td>
                      <td>{link.clicks}</td>
                      <td>
                        <a href={`${API_URL}/${link.shortCode}`} target="_blank" rel="noreferrer" className="open-link">
                          <FiExternalLink size={13} />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <span>&copy; {new Date().getFullYear()} Vaibhav Bombe</span>
        <span>URL Shortener — a Redis + MongoDB systems project</span>
      </footer>
    </div>
  )
}