import mongoose from 'mongoose';

const bookingSchema = new mongoose.Schema({
  userDetails: {
    name: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true }
  },
  seatDetails: {
    seatIndex: { type: Number },
    section: { type: String, required: true },
    row: { type: Number, required: true },
    seat: { type: Number, required: true },
    tier: { type: String, required: true },
    price: { type: Number, required: true },
    viewScore: { type: Number, default: 85 }
  },
  paymentDetails: {
    razorpayOrderId: { type: String, required: true },
    razorpayPaymentId: { type: String, required: true },
    razorpaySignature: { type: String, required: true },
    status: { type: String, default: 'PAID' }
  },
  bookingRef: { type: String, required: true, unique: true },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Booking', bookingSchema);