const mongoose = require('mongoose');   

const userSchema = new mongoose.Schema({
	username: { type: String, required: true },
	email: { type: String, required: true },
	score: { type: Number, default: 0 },
	// Notice how we only store strings, not the actual file!
	profilePicture: {
		url: String,
		public_id: String, // We save this so we can delete the image from Cloudinary later if the user changes their avatar
	},
});

module.exports = mongoose.model('User', userSchema);