const mongoose = require('mongoose')

const urlSchema = new mongoose.Schema({
  seq: { type: Number, index: true },
  shortCode: { type: String, required: true, unique: true },
  longUrl: { type: String, required: true },
  clicks: { type: Number, default: 0 },
  expiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
})

urlSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

module.exports = mongoose.models.Url || mongoose.model('Url', urlSchema)